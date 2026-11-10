// Checks the certificate a rehearsal's local HTTPS stack serves: trusted only where it is named, good for two names
// and for nothing else, not an authority, and cleaned up.
//
//   node local-cert-selftest.mjs
import { execFile, execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localCertificate } from "./local-cert.mjs";

let failed = 0;
const check = (passed, title, detail) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? ` (${detail})` : ""}`);
};

const made = localCertificate();
const x509 = new X509Certificate(made.ca);
check(x509.ca === false, "the certificate is not an authority");
check(x509.subjectAltName === "DNS:localhost, IP Address:127.0.0.1", "it names localhost and 127.0.0.1, and nothing else", x509.subjectAltName);
check(JSON.stringify(x509.keyUsage) === '["1.3.6.1.5.5.7.3.1"]', "it is for a TLS server only", JSON.stringify(x509.keyUsage));
const days = (new Date(x509.validTo) - Date.now()) / 86_400_000;
check(days > 1 && days <= 2, "it lasts two days", `${days.toFixed(2)} days`);
const text = execFileSync("openssl", ["x509", "-in", made.cert, "-noout", "-text"], { encoding: "utf8" });
check(/Basic Constraints: critical\s+CA:FALSE/.test(text), "CA:FALSE is critical");
check(/Key Usage: critical\s+Digital Signature, Key Encipherment\s/.test(text), "its key usage is critical, and has no certificate signing");

/** Serves `key` and `cert` on a free port, asks once with `options`, and says what happened: a status or an error code. */
async function ask(key, cert, host, options) {
  const server = createServer({ key, cert }, (_, res) => res.end("ok"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const answer = await new Promise((done) => {
    const sent = request(`https://${host}:${server.address().port}/`, { timeout: 10_000, ...options }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    sent.on("timeout", () => sent.destroy(new Error("timeout")));
    sent.on("error", (error) => done(error.code ?? error.message));
    sent.end();
  });
  server.close();
  return answer;
}
const key = readFileSync(made.key);
check((await ask(key, made.ca, "localhost", { ca: made.ca })) === 200, "a client given the certificate trusts the server as localhost");
check((await ask(key, made.ca, "127.0.0.1", { ca: made.ca })) === 200, "and as 127.0.0.1");
const untrusted = await ask(key, made.ca, "localhost", {});
check(untrusted === "DEPTH_ZERO_SELF_SIGNED_CERT", "a client not given it refuses the server, so checking is on", String(untrusted));

// A child process, as the journey is: trusted through NODE_EXTRA_CA_CERTS, and refused without.
{
  const server = createServer({ key, cert: made.ca }, (_, res) => res.end("ok"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const script = `fetch("https://127.0.0.1:${server.address().port}/").then((r) => console.log(r.status), (e) => console.log(e.cause?.code))`;
  const child = (env) => new Promise((done) => execFile(process.execPath, ["-e", script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }, (_, out) => done(out.trim())));
  check((await child({ NODE_EXTRA_CA_CERTS: made.cert })) === "200", "a child with NODE_EXTRA_CA_CERTS trusts it through fetch");
  const without = await child({});
  check(without === "DEPTH_ZERO_SELF_SIGNED_CERT", "a child without it refuses", without);
  server.close();
}

// The point of CA:FALSE: a certificate for the same names, signed with this run's key, is refused by a client that
// trusts this run's certificate. The same certificate signed by a real authority is accepted, so the refusal is for who
// signed it and not for how it was made.
{
  const file = (name) => join(made.dir, name);
  writeFileSync(file("names.ext"), "subjectAltName = DNS:localhost,IP:127.0.0.1\n");
  writeFileSync(file("authority.cnf"), "[req]\ndistinguished_name = subject\nx509_extensions = authority\nprompt = no\n[subject]\nCN = a test authority\n[authority]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign\n");
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", file("authority.cnf"), "-keyout", file("authority-key.pem"), "-out", file("authority.pem"));
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", file("other-key.pem"), "-out", file("other.csr"));
  const signedBy = (cert, key, out) => openssl("x509", "-req", "-in", file("other.csr"), "-CA", cert, "-CAkey", key, "-CAcreateserial", "-days", "2", "-extfile", file("names.ext"), "-out", file(out));
  signedBy(file("authority.pem"), file("authority-key.pem"), "by-authority.pem");
  signedBy(made.cert, made.key, "by-run.pem");
  const otherKey = readFileSync(file("other-key.pem"));
  const byAuthority = await ask(otherKey, readFileSync(file("by-authority.pem")), "localhost", { ca: readFileSync(file("authority.pem")) });
  check(byAuthority === 200, "a certificate signed by a real authority is trusted by a client given that authority", String(byAuthority));
  const byRun = await ask(otherKey, readFileSync(file("by-run.pem")), "localhost", { ca: made.ca });
  // What Node reports when the signer it was given isn't allowed to sign certificates.
  check(byRun === "UNSPECIFIED" || byRun === "INVALID_CA", "the same certificate signed with this run's key fails verification, so the key can't vouch for another", String(byRun));
}

check(existsSync(made.key), "the key is there while the run needs it");
made.remove();
check(!existsSync(made.dir), "and is gone, with its folder, once removed");

// A signal removes it too. A child makes one, says where, and waits to be told to stop.
for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  const script = `import { localCertificate } from "./local-cert.mjs"; console.log(localCertificate().dir); setInterval(() => {}, 1000);`;
  const proc = execFile(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL(".", import.meta.url), encoding: "utf8" });
  const dir = await new Promise((done, fail) => {
    proc.stdout.once("data", (line) => done(line.trim()));
    setTimeout(() => fail(new Error("the child made no certificate within 60 s")), 60_000).unref();
  });
  const there = existsSync(join(dir, "key.pem"));
  const ended = new Promise((done) => proc.once("exit", done));
  proc.kill(signal);
  const code = await ended;
  check(there && !existsSync(dir), `${signal} removes the key and its folder`);
  check(code === status, `and ends the run with ${status}`, `exit ${code}`);
}

// No openssl, or one that fails, says so plainly, passes on what it said, and leaves nothing behind.
{
  const fakeDir = mkdtempSync(join(tmpdir(), "podster-e2e-fake-openssl-"));
  const failing = join(fakeDir, "openssl");
  writeFileSync(failing, "#!/bin/sh\necho 'req: unable to load the config' >&2\nexit 1\n", { mode: 0o755 });
  const left = () => readdirSync(tmpdir()).filter((name) => name.startsWith("podster-e2e-tls-")).length;
  for (const [openssl, expected, title] of [
    [join(fakeDir, "missing"), /needs the openssl command.*isn't installed or isn't on PATH/s, "a missing openssl is named as what the run needs"],
    [failing, /needs the openssl command.* req` failed:\nreq: unable to load the config$/s, "an openssl that fails is reported with what it said"],
  ]) {
    const before = left();
    let message = "";
    try {
      localCertificate({ openssl });
    } catch (error) {
      message = error.message;
    }
    check(expected.test(message), title, message.split("\n")[0].slice(0, 110));
    check(left() === before, "and it leaves no folder behind");
  }
  rmSync(fakeDir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nthe local certificate: all checks passed" : `\nthe local certificate: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
