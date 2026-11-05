// Simula la regla de polkit sin tocar el sistema: node deploy/test-polkit-rule.js
const fs = require("node:fs");
const path = require("node:path");

let rule;
const polkit = {
  Result: { YES: "yes", NO: "no", NOT_HANDLED: "not_handled" },
  addRule: (f) => {
    rule = f;
  },
};
new Function("polkit", fs.readFileSync(path.join(__dirname, "50-asistente.rules"), "utf8"))(polkit);

const action = (unit, verb) => ({
  id: "org.freedesktop.systemd1.manage-units",
  lookup: (k) => (k === "unit" ? unit : verb),
});
const cases = [
  ["opsbot", "bentonime.service", "restart", "yes"],
  ["opsbot", "bentonime.service", "stop", "no"],
  ["opsbot", "server-backup@sistema.service", "start", "yes"],
  ["opsbot", "server-backup@clientes.service", "start", "no"],
  ["opsbot", "wings.service", "restart", "no"],
  ["bentonime", "bentonime.service", "restart", "not_handled"],
];
let failed = 0;
for (const [user, unit, verb, expected] of cases) {
  const got = rule(action(unit, verb), { user });
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "MAL "} ${user} ${verb} ${unit} -> ${got}`);
}
const other = rule({ id: "org.freedesktop.login1.reboot", lookup: () => "" }, { user: "opsbot" });
console.log(`${other === "not_handled" ? "ok  " : "MAL "} opsbot reboot -> ${other}`);
process.exit(failed || other !== "not_handled" ? 1 : 0);
