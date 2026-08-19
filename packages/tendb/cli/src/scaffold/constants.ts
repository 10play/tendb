/** Git base for module sources in scaffolded terraform (docs/reference/terraform-engine). */
export const GIT_MODULE_BASE =
  "git::https://github.com/10play/tendb.git//packages/tendb/terraform/modules";

/** Keep in lockstep with package.json's version (tagged on the repo) — a
 * floating ref like `main` could drift from the installed CLI's templates. */
export const DEFAULT_MODULE_REF = "v0.1.2";

export const DEFAULT_SCAFFOLD_DIR = "tendb";

export const TERRAFORM_INSTALL_HINT =
  "install terraform: brew install terraform (or https://developer.hashicorp.com/terraform/install)";

/** tfvars value emitted when the user defers the source secret to later. */
export const SOURCE_SECRET_PLACEHOLDER = "REPLACE_WITH_SOURCE_SECRET_ARN";

/**
 * Internal module addresses the azure first-apply bootstrap targets (the
 * vault must exist before the source secret can be set — see
 * templates/azure/README.md). A module refactor renaming these breaks the
 * targeted apply; `tendb up` falls back to printed manual steps.
 */
export const AZURE_BOOTSTRAP_TARGETS = [
  "module.engine.azurerm_key_vault.this",
  "module.engine.azurerm_role_assignment.deployer_secrets",
] as const;
