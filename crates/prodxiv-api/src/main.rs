use std::sync::Arc;

use prodxiv_api::{ApiConfig, AppState, router};
use prodxiv_storage::PostgresStorage;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = ApiConfig::from_env()?;
    let migration_storage = PostgresStorage::connect(&config.migration_database_url, 1).await?;
    migration_storage.migrate().await?;
    migration_storage.pool().close().await;
    tracing::info!("prodxiv database migrations are current");

    let storage = PostgresStorage::connect(&config.database_url, 10).await?;
    let state = AppState::new(
        Arc::new(storage),
        config.publish_token,
        config.publish_actor,
    )
    .with_bot_principal(config.bot_token, config.bot_actor)
    .with_trending_ingestion(config.trending_ingest_token);
    let listener = TcpListener::bind(config.bind_address).await?;
    tracing::info!(address = %config.bind_address, "prodxiv API listening");

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Ctrl+C signal handler should install");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM signal handler should install")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }
}
