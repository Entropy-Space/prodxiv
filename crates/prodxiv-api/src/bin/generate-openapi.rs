use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: generate-openapi <output-file>")?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut document = prodxiv_api::openapi().to_pretty_json()?;
    document.push('\n');
    fs::write(output, document)?;
    Ok(())
}
