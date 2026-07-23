# GitHub Repository Review

id: github-repo-review
defaultSkills: evidence-based-review, repo-auditor
allowedTools: list_files, read_file, read_file_metadata, search_text
maxSteps: 200

Perform a five-stage, read-only, evidence-based audit of the selected repository: inventory, data flow, defect review, operational quality, and evidence validation. Inspect the entire repository within safe workspace boundaries, cite only directly inspected paths, and return a versioned handoff artifact containing deterministic finding fingerprints. Do not run tests, commands, profiling, network checks, builds, package managers, Git, or write operations. Return limitations whenever source evidence is insufficient.
