use std::{env, fs, path::PathBuf};

use prodxiv_storage::{NewGitHubTrendingSnapshot, PostgresStorage};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input_path = input_path()?;
    let database_url = direct_database_url()?;
    let source = fs::read_to_string(&input_path)?;
    let snapshot: NewGitHubTrendingSnapshot = serde_json::from_str(&source)?;

    let storage = PostgresStorage::connect(&database_url, 1).await?;
    storage.migrate().await?;
    let outcome = storage.import_github_trending_snapshot(&snapshot).await?;
    let action = if outcome.inserted {
        "imported"
    } else {
        "already present"
    };
    println!(
        "{action}: snapshot {} with {} entries from {}",
        outcome.snapshot_id,
        outcome.entry_count,
        input_path.display()
    );
    Ok(())
}

fn input_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    env::args_os().nth(1).map(PathBuf::from).ok_or_else(|| {
        "usage: prodxiv-import-github-trending <snapshot.json>"
            .to_owned()
            .into()
    })
}

fn direct_database_url() -> Result<String, Box<dyn std::error::Error>> {
    env::var("DIRECT_DATABASE_URL")
        .or_else(|_| env::var("DATABASE_URL_UNPOOLED"))
        .or_else(|_| env::var("DATABASE_URL"))
        .map_err(|_| {
            "DIRECT_DATABASE_URL, DATABASE_URL_UNPOOLED, or DATABASE_URL is required"
                .to_owned()
                .into()
        })
}
