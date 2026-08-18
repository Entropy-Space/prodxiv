use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use jsonwebtoken::{
    Algorithm, DecodingKey, Validation, decode, decode_header, get_current_timestamp,
    jwk::{AlgorithmParameters, Jwk, JwkSet, KeyAlgorithm, PublicKeyUse},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;

const GITHUB_OIDC_ISSUER: &str = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL: &str = "https://token.actions.githubusercontent.com/.well-known/jwks";
const GITHUB_OIDC_AUDIENCE: &str = "prodxiv-api";
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_JWKS_BYTES: usize = 256 * 1024;
const MAX_TOKEN_LIFETIME_SECONDS: u64 = 10 * 60;
const CLOCK_SKEW_SECONDS: u64 = 60;
const CACHED_KEY_LIFETIME: Duration = Duration::from_secs(60 * 60);
const UNKNOWN_KEY_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitHubActionsWorkload {
    Paperbot,
    Trending,
}

impl GitHubActionsWorkload {
    fn workflow_path(self) -> &'static str {
        match self {
            Self::Paperbot => ".github/workflows/evaluate-paperbot.yml",
            Self::Trending => ".github/workflows/collect-github-trending.yml",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubOidcTrust {
    repository: String,
    repository_id: u64,
    environment: String,
}

impl GitHubOidcTrust {
    /// Creates the exact GitHub repository and Environment trust boundary.
    ///
    /// # Errors
    ///
    /// Returns an error when a repository, repository ID, or environment is
    /// malformed.
    pub fn new(
        repository: impl Into<String>,
        repository_id: impl AsRef<str>,
        environment: impl Into<String>,
    ) -> Result<Self, GitHubOidcTrustError> {
        let repository = repository.into();
        let Some((owner, name)) = repository.split_once('/') else {
            return Err(GitHubOidcTrustError::InvalidRepository);
        };
        if owner.is_empty()
            || name.is_empty()
            || name.contains('/')
            || !owner.chars().all(valid_repository_character)
            || !name.chars().all(valid_repository_character)
        {
            return Err(GitHubOidcTrustError::InvalidRepository);
        }
        let repository_id = repository_id
            .as_ref()
            .parse::<u64>()
            .ok()
            .filter(|repository_id| *repository_id > 0)
            .ok_or(GitHubOidcTrustError::InvalidRepositoryId)?;
        let environment = environment.into();
        if environment.trim() != environment
            || environment.is_empty()
            || environment.len() > 255
            || environment.chars().any(char::is_control)
        {
            return Err(GitHubOidcTrustError::InvalidEnvironment);
        }
        Ok(Self {
            repository,
            repository_id,
            environment,
        })
    }

    fn expected_workflow_ref(&self, workload: GitHubActionsWorkload) -> String {
        format!(
            "{}/{}@refs/heads/main",
            self.repository,
            workload.workflow_path()
        )
    }

    fn accepts_subject(&self, claims: &GitHubOidcClaims) -> bool {
        let environment = claims.environment.replace(':', "%3A");
        let legacy = format!("repo:{}:environment:{environment}", self.repository);
        let Some((owner, repository)) = self.repository.split_once('/') else {
            return false;
        };
        let Ok(owner_id) = claims.repository_owner_id.parse::<u64>() else {
            return false;
        };
        let immutable = format!(
            "repo:{owner}@{owner_id}/{repository}@{}:environment:{environment}",
            self.repository_id
        );
        claims.sub == legacy || claims.sub == immutable
    }
}

fn valid_repository_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum GitHubOidcTrustError {
    #[error("PRODXIV_GITHUB_OIDC_REPOSITORY must use owner/repository syntax")]
    InvalidRepository,
    #[error("PRODXIV_GITHUB_OIDC_REPOSITORY_ID must be a positive integer")]
    InvalidRepositoryId,
    #[error("PRODXIV_GITHUB_OIDC_ENVIRONMENT must be a non-empty GitHub Environment name")]
    InvalidEnvironment,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum GitHubOidcAuthenticationError {
    #[error("GitHub Actions OIDC token is invalid")]
    InvalidToken,
    #[error("GitHub Actions OIDC keys are temporarily unavailable")]
    IdentityProviderUnavailable,
}

#[async_trait]
pub trait GitHubOidcAuthenticator: Send + Sync {
    async fn authenticate(
        &self,
        token: &str,
        workload: GitHubActionsWorkload,
    ) -> Result<(), GitHubOidcAuthenticationError>;
}

pub struct GitHubOidcVerifier {
    trust: GitHubOidcTrust,
    keys: GitHubOidcKeyCache,
}

impl GitHubOidcVerifier {
    /// Creates a verifier backed by GitHub's public Actions OIDC key set.
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTPS client cannot be initialized.
    pub fn new(trust: GitHubOidcTrust) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(5))
            .user_agent("prodxiv-api/0.1 github-oidc-verifier")
            .build()?;
        Ok(Self::with_fetcher(
            trust,
            Arc::new(HttpGitHubOidcKeyFetcher { client }),
        ))
    }

    fn with_fetcher(trust: GitHubOidcTrust, fetcher: Arc<dyn GitHubOidcKeyFetcher>) -> Self {
        Self {
            trust,
            keys: GitHubOidcKeyCache::new(fetcher),
        }
    }

    async fn verify(
        &self,
        token: &str,
        workload: GitHubActionsWorkload,
    ) -> Result<(), GitHubOidcAuthenticationError> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(GitHubOidcAuthenticationError::InvalidToken);
        }
        let header = decode_header(token).map_err(|error| {
            tracing::warn!(%error, "rejected malformed GitHub OIDC token header");
            GitHubOidcAuthenticationError::InvalidToken
        })?;
        if header.alg != Algorithm::RS256 || header.typ.as_deref() != Some("JWT") {
            return Err(GitHubOidcAuthenticationError::InvalidToken);
        }
        let kid = header
            .kid
            .as_deref()
            .filter(|kid| !kid.is_empty() && kid.len() <= 256)
            .ok_or(GitHubOidcAuthenticationError::InvalidToken)?;
        let key = self.keys.decoding_key(kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = CLOCK_SKEW_SECONDS;
        validation.validate_nbf = true;
        validation.set_audience(&[GITHUB_OIDC_AUDIENCE]);
        validation.set_issuer(&[GITHUB_OIDC_ISSUER]);
        validation.set_required_spec_claims(&["aud", "exp", "iss", "nbf", "sub"]);
        let claims = decode::<GitHubOidcClaims>(token, &key, &validation)
            .map_err(|error| {
                tracing::warn!(%error, "rejected invalid GitHub OIDC token signature or standard claims");
                GitHubOidcAuthenticationError::InvalidToken
            })?
            .claims;
        self.validate_claims(&claims, workload)
    }

    fn validate_claims(
        &self,
        claims: &GitHubOidcClaims,
        workload: GitHubActionsWorkload,
    ) -> Result<(), GitHubOidcAuthenticationError> {
        let now = get_current_timestamp();
        let valid_lifetime = claims.exp > claims.iat
            && claims.exp.saturating_sub(claims.iat) <= MAX_TOKEN_LIFETIME_SECONDS
            && claims.iat <= now.saturating_add(CLOCK_SKEW_SECONDS);
        let valid_repository = claims.repository == self.trust.repository
            && claims.repository_id.parse::<u64>().ok() == Some(self.trust.repository_id);
        let valid_context = claims.environment == self.trust.environment
            && claims.git_ref == "refs/heads/main"
            && claims.ref_type == "branch"
            && matches!(claims.event_name.as_str(), "schedule" | "workflow_dispatch")
            && claims.workflow_ref == self.trust.expected_workflow_ref(workload)
            && self.trust.accepts_subject(claims);
        let valid_lineage = !claims.jti.is_empty()
            && claims.jti.len() <= 256
            && claims.run_id.parse::<u64>().is_ok_and(|run_id| run_id > 0)
            && claims
                .run_attempt
                .parse::<u64>()
                .is_ok_and(|attempt| attempt > 0);
        if valid_lifetime && valid_repository && valid_context && valid_lineage {
            Ok(())
        } else {
            tracing::warn!(
                workload = ?workload,
                repository = %claims.repository,
                repository_id = %claims.repository_id,
                environment = %claims.environment,
                workflow_ref = %claims.workflow_ref,
                git_ref = %claims.git_ref,
                event_name = %claims.event_name,
                "rejected GitHub OIDC token outside the configured trust boundary"
            );
            Err(GitHubOidcAuthenticationError::InvalidToken)
        }
    }
}

#[async_trait]
impl GitHubOidcAuthenticator for GitHubOidcVerifier {
    async fn authenticate(
        &self,
        token: &str,
        workload: GitHubActionsWorkload,
    ) -> Result<(), GitHubOidcAuthenticationError> {
        self.verify(token, workload).await
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GitHubOidcClaims {
    aud: String,
    exp: u64,
    iat: u64,
    nbf: u64,
    iss: String,
    sub: String,
    jti: String,
    repository: String,
    repository_id: String,
    repository_owner_id: String,
    environment: String,
    #[serde(rename = "ref")]
    git_ref: String,
    ref_type: String,
    event_name: String,
    workflow_ref: String,
    run_id: String,
    run_attempt: String,
}

struct GitHubOidcKeyCache {
    fetcher: Arc<dyn GitHubOidcKeyFetcher>,
    cached: Mutex<Option<CachedGitHubOidcKeys>>,
}

impl GitHubOidcKeyCache {
    fn new(fetcher: Arc<dyn GitHubOidcKeyFetcher>) -> Self {
        Self {
            fetcher,
            cached: Mutex::new(None),
        }
    }

    async fn decoding_key(&self, kid: &str) -> Result<DecodingKey, GitHubOidcAuthenticationError> {
        let mut cached = self.cached.lock().await;
        if let Some(keys) = cached.as_ref() {
            let age = keys.fetched_at.elapsed();
            if age <= CACHED_KEY_LIFETIME
                && let Some(key) = keys.jwks.find(kid)
            {
                return decoding_key(key);
            }
            if age < UNKNOWN_KEY_REFRESH_INTERVAL {
                return Err(GitHubOidcAuthenticationError::InvalidToken);
            }
        }

        let jwks = self.fetcher.fetch().await.map_err(|error| {
            tracing::error!(%error, "failed to refresh GitHub Actions OIDC keys");
            GitHubOidcAuthenticationError::IdentityProviderUnavailable
        })?;
        if jwks.keys.is_empty() {
            tracing::error!("GitHub Actions OIDC key set was empty");
            return Err(GitHubOidcAuthenticationError::IdentityProviderUnavailable);
        }
        let key = jwks
            .find(kid)
            .map(decoding_key)
            .transpose()?
            .ok_or(GitHubOidcAuthenticationError::InvalidToken)?;
        *cached = Some(CachedGitHubOidcKeys {
            jwks,
            fetched_at: Instant::now(),
        });
        Ok(key)
    }
}

struct CachedGitHubOidcKeys {
    jwks: JwkSet,
    fetched_at: Instant,
}

fn decoding_key(jwk: &Jwk) -> Result<DecodingKey, GitHubOidcAuthenticationError> {
    if jwk.common.key_algorithm != Some(KeyAlgorithm::RS256)
        || jwk.common.public_key_use != Some(PublicKeyUse::Signature)
        || !matches!(jwk.algorithm, AlgorithmParameters::RSA(_))
    {
        return Err(GitHubOidcAuthenticationError::InvalidToken);
    }
    DecodingKey::from_jwk(jwk).map_err(|error| {
        tracing::warn!(%error, "rejected unusable GitHub OIDC signing key");
        GitHubOidcAuthenticationError::InvalidToken
    })
}

#[derive(Debug, Error)]
#[error("{message}")]
struct GitHubOidcKeyFetchError {
    message: String,
}

#[async_trait]
trait GitHubOidcKeyFetcher: Send + Sync {
    async fn fetch(&self) -> Result<JwkSet, GitHubOidcKeyFetchError>;
}

struct HttpGitHubOidcKeyFetcher {
    client: reqwest::Client,
}

#[async_trait]
impl GitHubOidcKeyFetcher for HttpGitHubOidcKeyFetcher {
    async fn fetch(&self) -> Result<JwkSet, GitHubOidcKeyFetchError> {
        let response = self
            .client
            .get(GITHUB_OIDC_JWKS_URL)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(key_fetch_error)?;
        let body = response.bytes().await.map_err(key_fetch_error)?;
        if body.len() > MAX_JWKS_BYTES {
            return Err(GitHubOidcKeyFetchError {
                message: "GitHub OIDC key response exceeded the size limit".to_owned(),
            });
        }
        serde_json::from_slice(&body).map_err(|error| GitHubOidcKeyFetchError {
            message: format!("GitHub OIDC key response was invalid JSON: {error}"),
        })
    }
}

fn key_fetch_error(error: reqwest::Error) -> GitHubOidcKeyFetchError {
    GitHubOidcKeyFetchError {
        message: format!("GitHub OIDC key request failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use jsonwebtoken::{
        Algorithm, EncodingKey, Header, encode,
        jwk::{Jwk, JwkSet, KeyAlgorithm, PublicKeyUse},
    };
    use rand::rngs::OsRng;
    use rsa::{RsaPrivateKey, pkcs1::EncodeRsaPrivateKey};

    use super::{
        GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_ISSUER, GitHubActionsWorkload,
        GitHubOidcAuthenticationError, GitHubOidcClaims, GitHubOidcKeyFetchError,
        GitHubOidcKeyFetcher, GitHubOidcTrust, GitHubOidcVerifier, get_current_timestamp,
    };

    struct StaticKeyFetcher {
        jwks: JwkSet,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl GitHubOidcKeyFetcher for StaticKeyFetcher {
        async fn fetch(&self) -> Result<JwkSet, GitHubOidcKeyFetchError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(self.jwks.clone())
        }
    }

    #[tokio::test]
    async fn accepts_only_the_exact_workload_context() {
        let (verifier, fetcher) = verifier();
        let claims = claims(GitHubActionsWorkload::Paperbot);
        verifier
            .verify(&signed_token(&claims), GitHubActionsWorkload::Paperbot)
            .await
            .expect("the exact Paperbot workflow should authenticate");
        assert_eq!(fetcher.calls.load(Ordering::Relaxed), 1);

        let error = verifier
            .verify(&signed_token(&claims), GitHubActionsWorkload::Trending)
            .await
            .expect_err("a Paperbot token must not receive Trending authority");
        assert_eq!(error, GitHubOidcAuthenticationError::InvalidToken);
        assert_eq!(fetcher.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn accepts_githubs_immutable_subject_format() {
        let (verifier, _) = verifier();
        let mut claims = claims(GitHubActionsWorkload::Paperbot);
        claims.sub =
            "repo:Entropy-Space@12345/prodxiv@1313713424:environment:production".to_owned();
        verifier
            .verify(&signed_token(&claims), GitHubActionsWorkload::Paperbot)
            .await
            .expect("the immutable repository subject should authenticate");
    }

    #[tokio::test]
    async fn rejects_other_refs_events_and_repository_ids() {
        let (verifier, _) = verifier();
        for mutate in [
            |claims: &mut GitHubOidcClaims| claims.git_ref = "refs/heads/feature".to_owned(),
            |claims: &mut GitHubOidcClaims| claims.event_name = "pull_request".to_owned(),
            |claims: &mut GitHubOidcClaims| claims.repository_id = "999".to_owned(),
        ] {
            let mut claims = claims(GitHubActionsWorkload::Paperbot);
            mutate(&mut claims);
            let error = verifier
                .verify(&signed_token(&claims), GitHubActionsWorkload::Paperbot)
                .await
                .expect_err("an out-of-bound claim must be rejected");
            assert_eq!(error, GitHubOidcAuthenticationError::InvalidToken);
        }
    }

    fn verifier() -> (GitHubOidcVerifier, Arc<StaticKeyFetcher>) {
        let mut jwk = Jwk::from_encoding_key(test_encoding_key(), Algorithm::RS256)
            .expect("test RSA key should produce a JWK");
        jwk.common.key_id = Some("test-key".to_owned());
        jwk.common.key_algorithm = Some(KeyAlgorithm::RS256);
        jwk.common.public_key_use = Some(PublicKeyUse::Signature);
        let fetcher = Arc::new(StaticKeyFetcher {
            jwks: JwkSet { keys: vec![jwk] },
            calls: AtomicUsize::new(0),
        });
        let trust = GitHubOidcTrust::new("Entropy-Space/prodxiv", "1313713424", "production")
            .expect("test trust should be valid");
        (
            GitHubOidcVerifier::with_fetcher(trust, fetcher.clone()),
            fetcher,
        )
    }

    fn claims(workload: GitHubActionsWorkload) -> GitHubOidcClaims {
        let now = get_current_timestamp();
        GitHubOidcClaims {
            aud: GITHUB_OIDC_AUDIENCE.to_owned(),
            exp: now + 300,
            iat: now,
            nbf: now,
            iss: GITHUB_OIDC_ISSUER.to_owned(),
            sub: "repo:Entropy-Space/prodxiv:environment:production".to_owned(),
            jti: "00000000-0000-4000-8000-000000000001".to_owned(),
            repository: "Entropy-Space/prodxiv".to_owned(),
            repository_id: "1313713424".to_owned(),
            repository_owner_id: "12345".to_owned(),
            environment: "production".to_owned(),
            git_ref: "refs/heads/main".to_owned(),
            ref_type: "branch".to_owned(),
            event_name: "schedule".to_owned(),
            workflow_ref: format!(
                "Entropy-Space/prodxiv/{}@refs/heads/main",
                workload.workflow_path()
            ),
            run_id: "123456".to_owned(),
            run_attempt: "1".to_owned(),
        }
    }

    fn signed_token(claims: &GitHubOidcClaims) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-key".to_owned());
        encode(&header, claims, test_encoding_key()).expect("test token should encode")
    }

    fn test_encoding_key() -> &'static EncodingKey {
        static TEST_PRIVATE_KEY: OnceLock<EncodingKey> = OnceLock::new();
        TEST_PRIVATE_KEY.get_or_init(|| {
            let private_key = RsaPrivateKey::new(&mut OsRng, 2_048)
                .expect("test RSA private key should generate");
            let private_key = private_key
                .to_pkcs1_der()
                .expect("test RSA private key should encode");
            EncodingKey::from_rsa_der(private_key.as_bytes())
        })
    }
}
