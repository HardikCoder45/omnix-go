# omnix-go Python shim

This package provides the `omnix-go` command through the npm implementation. On
first use it downloads and SHA-256-verifies a private Node.js 24 runtime when a
compatible system runtime is unavailable. OmniX Go then installs its verified gateway
connector runtime and the per-user login service automatically. Provision a permanent
endpoint with `omnix-go gateway provision --name <name>`.
