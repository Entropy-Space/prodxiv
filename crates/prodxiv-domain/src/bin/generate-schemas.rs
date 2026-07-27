use std::{env, fs, path::PathBuf};

use prodxiv_domain::{PaperDocument, ValidationReport, validation_policy};
use schemars::schema_for;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output_directory = env::args_os()
        .nth(1)
        .map_or_else(|| PathBuf::from("schemas"), PathBuf::from);
    fs::create_dir_all(&output_directory)?;

    write_schema(
        output_directory.join("paper.schema.json"),
        &schema_for!(PaperDocument),
    )?;
    write_schema(
        output_directory.join("validation.schema.json"),
        &schema_for!(ValidationReport),
    )?;

    let mut policy = serde_json::to_string_pretty(&validation_policy())?;
    policy.push('\n');
    fs::write(output_directory.join("validation-policy.json"), policy)?;
    Ok(())
}

fn write_schema(
    path: PathBuf,
    schema: &schemars::Schema,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut json = serde_json::to_string_pretty(schema)?;
    json.push('\n');
    fs::write(path, json)?;
    Ok(())
}
