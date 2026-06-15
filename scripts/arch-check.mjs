#!/usr/bin/env node
// Архитектурный аудит — детерминированная часть.
// Проверяет механические инварианты из CLAUDE.md «Архитектурные правила».
// Запуск: node scripts/arch-check.mjs   (exit 1, если есть 🔴-нарушения).
// «Судительные» правила (валидация ввода, идемпотентность, событийность и т.п.)
// проверяет LLM-часть команды /arch-audit — этот скрипт их НЕ покрывает.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (f) => relative(ROOT, f);
const read = (f) => readFileSync(f, 'utf8');

/** Строки файлов (по фильтру), удовлетворяющие предикату → [{file,line,text}]. */
function grep(predicate, fileFilter = () => true) {
  const hits = [];
  for (const f of files) {
    const r = rel(f);
    if (!fileFilter(r)) continue;
    read(f)
      .split('\n')
      .forEach((text, i) => {
        if (predicate(text, r)) hits.push({ file: r, line: i + 1, text: text.trim() });
      });
  }
  return hits;
}

const PRICE = /\b(depositPerBottle|electroPumpPrice|pumpPrice|waterStartPrice|price1|priceFrom2|priceFrom6)\b/;
const findings = [];

// 🔴 Правило 4 — БД только в сервисах модулей: в src/bots/ не дёргаем Prisma напрямую.
findings.push({
  sev: 'red',
  rule: 'Правило 4 — БД только в сервисах (боты без PrismaService/this.prisma)',
  hits: grep(
    (t) => /PrismaService|this\.prisma|prisma\/prisma\.service/.test(t),
    (f) => f.startsWith('src/bots/'),
  ),
});

// 🔴 Чистота FSM — *.fsm.ts без async и без импортов grammY/сервисов (только данные на вход).
findings.push({
  sev: 'red',
  rule: 'FSM-чистота — переходы без async/grammY/сервисов (*.fsm.ts)',
  hits: grep(
    (t) =>
      // настоящий async (не слово «async» в тексте/комментарии)
      /\basync\s*\(|\basync\s+function/.test(t) ||
      // value-импорт grammY/сервиса (import type стирается при компиляции — ок)
      ((/from 'grammy'/.test(t) || /from '[^']*\.service'/.test(t)) &&
        !/^\s*import type\b/.test(t)),
    (f) => f.endsWith('.fsm.ts'),
  ),
});

// 🔴 Prisma — импорт из generated/prisma, а не из @prisma/client (адаптер @prisma/adapter-pg — ок).
findings.push({
  sev: 'red',
  rule: 'Prisma — импорт типов/клиента из generated/prisma (не @prisma/client)',
  hits: grep((t) => /from '@prisma\/client'/.test(t)),
});

// 🟡 Покрытие чистой логики — export-функции *.fsm.ts должны упоминаться в *.fsm.spec.ts.
const ALLOW_UNCOVERED = new Set(['assertNever']);
const covGaps = [];
for (const f of files.filter((x) => x.endsWith('.fsm.ts'))) {
  const specPath = f.replace(/\.fsm\.ts$/, '.fsm.spec.ts');
  let spec = '';
  try {
    spec = read(specPath);
  } catch {
    /* спека нет — каждую функцию посчитаем непокрытой */
  }
  const names = [...read(f).matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]);
  for (const n of names) {
    if (ALLOW_UNCOVERED.has(n)) continue;
    if (!spec.includes(n)) {
      covGaps.push({ file: rel(f), line: 0, text: `export ${n} — не упомянут в ${rel(specPath)}` });
    }
  }
}
findings.push({
  sev: 'yellow',
  rule: 'Покрытие чистой логики юнит-тестами (*.fsm.ts → *.fsm.spec.ts)',
  hits: covGaps,
});

// 🟡 Правило 1 — деньги только в pricing.service: ценовое поле, умноженное вне него → на ревью.
findings.push({
  sev: 'yellow',
  rule: 'Правило 1 — расчёт суммы только в pricing.service (ценовое поле с «*» вне него — убедись, что это не расчёт)',
  hits: grep(
    (t) => PRICE.test(t) && /\*/.test(t),
    (f) => !f.includes('pricing/pricing.service') && !f.includes('pricing-settings/') && !f.endsWith('.spec.ts'),
  ),
});

// 🟡 Правило 6 — экраны сценария через replyInline/replyMenu: прямой ctx.reply в клиент-боте на ревью.
findings.push({
  sev: 'yellow',
  rule: 'Правило 6 — экраны сценария через replyInline/replyMenu (прямой ctx.reply — проверь, что это разовое сообщение, а не экран)',
  hits: grep((t) => /ctx\.reply\(/.test(t), (f) => f.endsWith('client-bot.service.ts')),
});

// 🟡 Дрейф схемы — schema.prisma новее сгенерённого клиента → нужен prisma:generate.
try {
  const schema = statSync(join(ROOT, 'prisma/schema.prisma')).mtimeMs;
  const client = statSync(join(ROOT, 'generated/prisma/client.ts')).mtimeMs;
  findings.push({
    sev: 'yellow',
    rule: 'Дрейф схемы — generated/prisma актуальнее schema.prisma',
    hits: schema > client ? [{ file: 'prisma/schema.prisma', line: 0, text: 'схема новее клиента — запусти npm run prisma:generate' }] : [],
  });
} catch {
  /* нет файлов — пропускаем */
}

// --- вывод ---
let red = 0;
let yellow = 0;
console.log('🔍 Архитектурный аудит (детерминированная часть) — CLAUDE.md\n');
for (const { sev, rule, hits } of findings) {
  const icon = sev === 'red' ? '🔴' : '🟡';
  console.log(`${icon} ${rule}`);
  if (hits.length === 0) {
    console.log('   ✓ чисто\n');
    continue;
  }
  for (const h of hits) {
    console.log(`   ${h.file}${h.line ? ':' + h.line : ''}  ${h.text}`);
    if (sev === 'red') red++;
    else yellow++;
  }
  console.log('');
}
console.log(`Итог: 🔴 ${red} · 🟡 ${yellow} (🟡 — на ручную проверку, не обязательно нарушение)`);
process.exit(red > 0 ? 1 : 0);
