# Extra root certificates

Every `*.crt` file here is installed into the image's trust store **before** the
first outbound HTTPS request, which is what makes the build work on networks
that intercept TLS.

`install.sh` fills this directory automatically from the host (see
`lib/collect-ca.mjs`). You can also drop a bundle in by hand and re-run
`doclaude self rebuild`, or point the installer at one:

```bash
./install.sh --ca-file /path/to/corporate-root.crt
```

Certificates are gitignored — a corporate root should not end up in a public
repository.
