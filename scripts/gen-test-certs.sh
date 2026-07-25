#!/bin/sh
# Generate a throwaway CA plus server/client certs for MirrorECMA TLS tests.
# Mirrors ModelMirrors' scripts/gen-certs.sh conventions.
#
# Usage:
#   scripts/gen-test-certs.sh <outdir>
#
# Produces in <outdir>: ca.crt, server.crt/server.key (SAN=127.0.0.1),
# client.crt/client.key.

set -eu

if [ $# -lt 1 ]; then
  echo "usage: $0 <outdir>" >&2
  exit 1
fi

OUT=$1
mkdir -p "$OUT"
cd "$OUT"

openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt \
  -days 1 -nodes -subj "/CN=MirrorECMA Test CA" 2>/dev/null

printf "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" > server.ext
printf "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n" > client.ext

issue() {
  name=$1
  cn=$2
  ext=$3
  openssl req -newkey rsa:2048 -keyout "$name.key" -out "$name.csr" \
    -nodes -subj "/CN=$cn" 2>/dev/null
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$name.crt" -days 1 -extfile "$ext" 2>/dev/null
  chmod 600 "$name.key"
  rm -f "$name.csr"
}

issue server 127.0.0.1 server.ext
issue client mirrorecma-test-client client.ext

rm -f server.ext client.ext ca.srl ca.key
