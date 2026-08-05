use prodxiv_storage::{GitHubTrendingLanguageScope, GitHubTrendingLanguageSelector};

#[test]
fn distinguishes_stored_scopes_from_read_selectors() {
    assert_eq!(
        GitHubTrendingLanguageScope::parse("any"),
        Some(GitHubTrendingLanguageScope::Any)
    );
    assert_eq!(GitHubTrendingLanguageScope::parse("all"), None);
    assert_eq!(GitHubTrendingLanguageScope::parse("Rust"), None);
    assert_eq!(
        GitHubTrendingLanguageSelector::parse("all"),
        Some(GitHubTrendingLanguageSelector::All)
    );
}

#[test]
fn serializes_any_without_exposing_the_database_null_codec() {
    assert_eq!(
        serde_json::to_string(&GitHubTrendingLanguageScope::Any)
            .expect("any scope should serialize"),
        "\"any\""
    );
    assert!(serde_json::from_str::<GitHubTrendingLanguageScope>("null").is_err());
    assert!(serde_json::from_str::<GitHubTrendingLanguageScope>("\"all\"").is_err());
}
