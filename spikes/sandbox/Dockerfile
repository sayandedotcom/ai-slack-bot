# Base image tag MUST match the @cloudflare/sandbox package version exactly.
# The SDK talks to the /container-server/sandbox binary baked into this image;
# a mismatched tag is a silent protocol skew, not a build error.
FROM docker.io/cloudflare/sandbox:0.12.5

# Ports must be declared here to be reachable under `wrangler dev`.
# 3000 is the sandbox control server itself (already EXPOSEd upstream, repeated
# for legibility). The rest are what the repro loop will actually bind.
EXPOSE 3000
EXPOSE 5173
EXPOSE 8080
