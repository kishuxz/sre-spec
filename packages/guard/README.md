# @checkpoint/guard

Guarded execution for Checkpoint v3.

The default test suite does not require Terraform. The sandboxed Terraform test is gated and uses only a local `terraform_data` resource in a temporary directory; it does not use cloud providers, credentials, `kubectl`, databases, or any real infrastructure.

To run the gated sandbox test:

```bash
CHECKPOINT_TERRAFORM_TEST=1 TERRAFORM_BIN=/path/to/terraform pnpm exec vitest run packages/guard/src/terraform.test.ts
```

