use prodxiv_api::migration_database_url_from_env;
use prodxiv_storage::PostgresStorage;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = migration_database_url_from_env()?;
    let storage = PostgresStorage::connect(&database_url, 1).await?;
    storage.migrate().await?;
    storage.pool().close().await;
    println!("prodxiv database migrations are current");
    Ok(())
}
