#!/usr/bin/env node
/* ==========================================================================
 * LogicSim 2.0 · 引擎回归测试
 *
 * 运行： node tests/engine.test.js
 * 依赖： 无（只用 Node 内置模块）
 *
 * 覆盖：
 *   A. 8 个连接词的语义 vs 独立参考实现（不依赖被测代码）
 *   B. 逆波兰模式 vs tests/fixtures.json（夹具由 2021 原版程序输出，锁定语义不回归）
 *   C. 图模型 JSON 结构 vs 夹具（保证对旧文件的兼容）
 *   D. 中缀写法与等价逆波兰写法
 *   E. 量词 ∀ / ∃
 *   F. 生成的 SEL 电路与表达式真值表一致
 *   G. 错误处理
 *   H. 纯数字变量名的 key 冲突（原版 bug）
 *   I. latch.json 可正常载入
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

/* ---------------------------------------------------------------- 载入引擎 */
const HELPERS = `
var __collectVars = function (t, s) {
  s = s || new Set();
  if (typeof t === 'string') { if (t !== '0' && t !== '1') { s.add(t); } return s; }
  __collectVars(t.S, s); __collectVars(t['0'], s); __collectVars(t['1'], s); return s;
};
var __evalTree = function (t, env) {
  if (typeof t === 'string') { return (t === '0' || t === '1') ? t : (env[t] || '0'); }
  var c = __evalTree(t.S, env);
  return __evalTree(c === '1' ? t['1'] : t['0'], env);
};
/* 按 SEL 语义仿真生成的电路：N = SI ? 1 路 : 0 路 */
var __evalCircuit = function (model, env) {
  var nodes = {}, ins = {};
  model.nodeArray.forEach(function (n) { nodes[String(n.key)] = n; });
  model.linkArray.forEach(function (l) { ins[String(l.to) + '|' + l.topid] = l; });
  function out(key, port) {
    var n = nodes[String(key)];
    if (!n) { throw new Error('缺少节点 ' + key); }
    if (n.type === '0') { return '0'; }
    if (n.type === '1') { return '1'; }
    if (n.type === 'Import') { return env[n.name] !== undefined ? env[n.name] : '0'; }
    if (n.type === 'SEL') {
      var v = inp(key, 'SI') === '1' ? inp(key, '1') : inp(key, '0');
      return port === 'P' ? (v === '1' ? '0' : '1') : v;
    }
    throw new Error('未知节点类型 ' + n.type);
  }
  function inp(key, port) {
    var l = ins[String(key) + '|' + port];
    return l ? out(l.from, l.frompid) : '0';
  }
  var exp = model.nodeArray.filter(function (n) { return n.type === 'Export'; })[0];
  return inp(exp.key, 'OUT');
};
var __truthRows = function (tree, model) {
  var vars = Array.from(__collectVars(tree)).sort();
  var rows = [], total = Math.pow(2, vars.length);
  for (var m = 0; m < total; m++) {
    var env = {}, bits = '';
    for (var j = 0; j < vars.length; j++) {
      var v = ((m >> (vars.length - 1 - j)) & 1) ? '1' : '0';
      env[vars[j]] = v; bits += v;
    }
    rows.push({ bits: bits, value: __evalTree(tree, env), circuit: model ? __evalCircuit(model, env) : null });
  }
  return { vars: vars, rows: rows };
};
var __parse = function (text, mode) {
  var p = LogicSim.parse(text, mode);
  if (!p.ok) { return { error: p.error }; }
  var model = LogicSim.ViewGen(LogicSim.ModelGen(p.tree));
  var t = __truthRows(p.tree, model);
  return {
    canonical: LogicSim.astToInfix(p.ast),
    vars: t.vars,
    rows: t.rows,
    model: model,
    flat: t.rows.map(function (r) { return r.bits + '=' + r.value; })
  };
};
`;

const ctx = vm.createContext({ console });
['LogicParser.js', 'ViewGen.js'].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx, { filename: file });
});
vm.runInContext(HELPERS, ctx);

const run = (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
const parse = (text, mode) => run(`__parse(${JSON.stringify(text)}, ${JSON.stringify(mode)})`);

/* ---------------------------------------------------------------- 断言工具 */
let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push({ name, detail });
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}

function group(title) {
  console.log('\n' + title);
}

/* ================================================================ A. 连接词 */
group('A. 连接词语义 vs 独立参考实现');

const REF = {
  not: (a) => a ? '0' : '1',
  and: (a, b) => (a === '1' && b === '1') ? '1' : '0',
  or: (a, b) => (a === '1' || b === '1') ? '1' : '0',
  xor: (a, b) => (a !== b) ? '1' : '0',
  nand: (a, b) => !(a === '1' && b === '1') ? '1' : '0',
  nor: (a, b) => !(a === '1' || b === '1') ? '1' : '0',
  implies: (a, b) => (a === '0' || b === '1') ? '1' : '0',
  xnor: (a, b) => (a === b) ? '1' : '0'
};

const FORMS = {
  not: ['¬a', '!a', '~a', 'not a'],
  and: ['a ∧ b', 'a & b', 'a · b', 'a && b', 'a and b'],
  or: ['a ∨ b', 'a | b', 'a + b', 'a || b', 'a or b'],
  xor: ['a ⊕ b', 'a ^ b', 'a xor b'],
  nand: ['a ↑ b', 'a nand b'],
  nor: ['a ↓ b', 'a nor b'],
  implies: ['a → b', 'a -> b', 'a ⇒ b', 'a implies b'],
  xnor: ['a ↔ b', 'a <-> b', 'a ≡ b', 'a == b', 'a xnor b']
};

Object.keys(FORMS).forEach(function (op) {
  const expected = op === 'not'
    ? ['0=1', '1=0']
    : ['00', '01', '10', '11'].map(bits => bits + '=' + REF[op](bits[0], bits[1]));
  FORMS[op].forEach(function (form) {
    const r = parse(form, 'infix');
    if (r.error) { check(`${op} 写法 ${form}`, false, r.error); return; }
    check(`${op} 写法 ${form} → ${r.flat.join(' ')}`, JSON.stringify(r.flat) === JSON.stringify(expected),
      JSON.stringify(r.flat) + ' ≠ ' + JSON.stringify(expected));
  });
});

/* ================================================================ B. 逆波兰回归 */
group('B. 逆波兰模式 vs 原版基准夹具');

const RPN_CASES = Object.keys(FIXTURES.cases);
RPN_CASES.forEach(function (expr) {
  const want = FIXTURES.cases[expr];
  if (want.error) { return; }
  const got = parse(expr, 'rpn');
  if (got.error) { check(`rpn "${expr}"`, false, got.error); return; }
  const sameVars = JSON.stringify(want.vars) === JSON.stringify(got.vars);
  const sameRows = JSON.stringify(want.rows) === JSON.stringify(got.flat);
  check(`rpn "${expr}"  (${want.vars.length} 变量 / ${want.rows.length} 行)`, sameVars && sameRows,
    sameVars ? JSON.stringify(want.rows) + ' ≠ ' + JSON.stringify(got.flat) : '变量集不同 ' + want.vars + ' vs ' + got.vars);
});

/* ================================================================ C. 模型结构兼容 */
group('C. 图模型 JSON 结构 vs 原版基准夹具');

RPN_CASES.forEach(function (expr) {
  const want = FIXTURES.cases[expr];
  if (want.error) { return; }
  const got = parse(expr, 'rpn');
  if (got.error) { return; }
  const nodes = got.model.nodeArray.map(n => [String(n.key), n.type, n.name === undefined ? null : n.name]);
  const links = got.model.linkArray.map(l => [String(l.from), String(l.frompid), String(l.to), String(l.topid)]);
  check(`模型 "${expr}"`, JSON.stringify(want.nodes) === JSON.stringify(nodes) && JSON.stringify(want.links) === JSON.stringify(links),
    '节点 ' + JSON.stringify(nodes) + '\n      期望 ' + JSON.stringify(want.nodes));
});

/* ================================================================ D. 中缀 vs 逆波兰 */
group('D. 中缀写法与等价逆波兰写法');

[
  ['a ∧ b', 'a b .'], ['a ∨ b', 'a b ,'], ['¬a', 'a <'],
  ['a → b', 'a b >'], ['a ↔ b', 'a b ='], ['a ⊕ b', 'a b ^'],
  ['(a ∧ b) → fe', 'a b . fe >'],
  ['(a ∧ b) ↔ (fe → ge)', 'a b . fe ge > ='],
  ['a ∨ ¬a', 'a a < ,'], ['a ∧ ¬a', 'a a < .'],
  ['(a ∨ b) ∧ c', 'a b , c .'], ['¬(a ∧ b)', 'a b . <'],
  ['a → (b → c)', 'a b c > >'],
  ['(a → b) ∧ (c → d)', 'a b > c d > .'],
  ['a ∧ b ∧ c', 'a b . c .'], ['a ∨ b ∨ c', 'a b , c ,'],
  ['a ∨ b ∧ c', 'a b c . ,'], ['a → b ∨ c', 'a b c , >']
].forEach(function (pair) {
  const a = parse(pair[0], 'infix'), b = parse(pair[1], 'rpn');
  if (a.error || b.error) { check(`${pair[0]} == ${pair[1]}`, false, `中缀:${a.error || 'ok'} 逆波兰:${b.error || 'ok'}`); return; }
  check(`${pair[0]}  ==  ${pair[1]}`, JSON.stringify(a.flat) === JSON.stringify(b.flat),
    JSON.stringify(a.flat) + ' ≠ ' + JSON.stringify(b.flat));
});

/* ================================================================ E. 量词 */
group('E. 量词 ∀ / ∃（有限域折叠）');

[
  ['∀(a, b)', 'a ∧ b'], ['∀(a, b, c)', 'a ∧ b ∧ c'],
  ['∃(a, b)', 'a ∨ b'], ['∃(a, b, c)', 'a ∨ b ∨ c'],
  ['∀(a b)', 'a ∧ b'], ['∃(a b c d)', 'a ∨ b ∨ c ∨ d'],
  ['∀(a, b) ↔ ∃(c, d)', '(a ∧ b) ↔ (c ∨ d)'],
  /* 这个式子是恒真式：常量折叠后没有变量，所以和带变量的等价写法行数不同，
     单独用「每行都是 1」来断言 */
  ['∀(a, b, c) → ∃(a, b)', '(a ∧ b ∧ c) → (a ∨ b)']
].forEach(function (pair) {
  const a = parse(pair[0], 'infix'), b = parse(pair[1], 'infix');
  if (a.error || b.error) { check(`${pair[0]} == ${pair[1]}`, false, (a.error || '') + (b.error || '')); return; }
  check(`${pair[0]}  ==  ${pair[1]}`, JSON.stringify(a.flat) === JSON.stringify(b.flat),
    JSON.stringify(a.flat) + ' ≠ ' + JSON.stringify(b.flat));
});

(function () {
  const r = parse('∀(a, b, c) → ∃(a, b)', 'infix');
  check('∀(a, b, c) → ∃(a, b) 是恒真式（会被常量折叠成一个常量一）',
    !r.error && r.rows.every(row => row.value === '1'),
    r.error || JSON.stringify(r.flat));
})();

/* ================================================================ F. 电路正确性 */
group('F. 生成的 SEL 电路与表达式真值表一致');

[['a', 'rpn'], ['0', 'rpn'], ['1', 'rpn'], ['a <', 'rpn'], ['a b .', 'rpn'], ['a b ,', 'rpn'],
['a b >', 'rpn'], ['a b =', 'rpn'], ['a b ^', 'rpn'], ['a b nand', 'rpn'], ['a b nor', 'rpn'],
['a b . fe >', 'rpn'], ['a b . fe ge > =', 'rpn'], ['a b = c d = ,', 'rpn'],
['p q r s . . .', 'rpn'], ['(a ∧ b) → fe', 'infix'], ['∀(a, b, c) → ∃(a, b)', 'infix'],
['a ⊕ b ⊕ c', 'infix'], ['¬a ∨ b', 'infix'], ['(a ↔ b) ∧ (c → d)', 'infix'],
['a ∨ ¬a', 'infix'], ['a ∧ ¬a', 'infix'], ['(a ↑ b) ↓ c', 'infix'], ['a → (b → c)', 'infix'],
['3 4 .', 'rpn'], ['10 20 ,', 'rpn']
].forEach(function (pair) {
  const r = parse(pair[0], pair[1]);
  if (r.error) { check(`电路 "${pair[0]}"`, false, r.error); return; }
  const bad = r.rows.filter(row => row.value !== row.circuit);
  check(`电路 "${pair[0]}"  (${r.rows.length} 行)`, bad.length === 0,
    bad.map(b => b.bits + ': 表达式=' + b.value + ' 电路=' + b.circuit).join('  '));
});

/* ================================================================ G. 错误处理 */
group('G. 错误处理');

[['', 'infix', true], ['', 'rpn', true],
['a b', 'rpn', true], ['a b . c', 'rpn', true], ['a b and c', 'rpn', true],
['a b .', 'rpn', false], ['a', 'rpn', false],
['a ∧', 'infix', true], ['(a ∧ b', 'infix', true], ['a ∧ b)', 'infix', true],
['∀()', 'infix', true], ['a @ b', 'infix', true], ['a - b', 'infix', true],
['a ∧ ∧ b', 'infix', true], ['a, b', 'infix', true],
['(a)', 'infix', false], ['¬¬a', 'infix', false], ['1 ∧ 0', 'infix', false],
['∀(a, b)', 'infix', false], ['a < <', 'rpn', false]
].forEach(function (item) {
  const r = parse(item[0], item[1]);
  const isError = !!r.error;
  check(`"${item[0]}" (${item[1]}) → ${isError ? '报错: ' + r.error.slice(0, 44) : '通过'}`,
    isError === item[2], `期望${item[2] ? '报错' : '通过'}，实际相反`);
});

/* ================================================================ H. key 冲突 */
group('H. 纯数字变量名的 key 冲突（原版 bug 的修复）');

function audit(model) {
  const keys = model.nodeArray.map(n => String(n.key));
  const dup = Array.from(new Set(keys.filter((k, i) => keys.indexOf(k) !== i)));
  const missing = model.linkArray.filter(l =>
    !keys.includes(String(l.from)) || !keys.includes(String(l.to)));
  return { keys, dup, missing };
}

const numericModels = ['3 4 .', '10 20 ,', '3 4 . 5 >', '1 0 .'].map(expr => ({
  expr, model: parse(expr, 'rpn').model
}));
numericModels.forEach(function (item) {
  const a = audit(item.model);
  check(`"${item.expr}" key 无重复且无悬空连线`, a.dup.length === 0 && a.missing.length === 0,
    'key=' + JSON.stringify(a.keys) + ' 重复=' + JSON.stringify(a.dup) + ' 悬空=' + a.missing.length);
});
check('纯数字变量确实被改写成 v 前缀（避免与自动编号撞车）',
  audit(numericModels[0].model).keys.some(k => k === 'v3' || k === 'v4'),
  JSON.stringify(audit(numericModels[0].model).keys));

/* 宽表达式：所有 key 唯一、连线闭合 */
(function () {
  const wide = parse('(a ∨ b) ∧ (c ∨ ¬d) ∧ (e → f) ∧ (g ↔ h)', 'infix');
  const a = audit(wide.model);
  check('16 行表达式生成的图 key 唯一且连线闭合',
    a.dup.length === 0 && a.missing.length === 0 && wide.model.nodeArray.length > 10,
    '节点 ' + wide.model.nodeArray.length + ' 重复 ' + JSON.stringify(a.dup) + ' 悬空 ' + a.missing.length);
})();

/* ================================================================ I. latch.json */
group('I. 旧文件 latch.json');

(function () {
  const latch = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'latch.json'), 'utf8'));
  check('latch.json 结构完整', Array.isArray(latch.nodeArray) && Array.isArray(latch.linkArray));
  const a = audit(latch);
  check('latch.json 的连线引用全部有效', a.missing.length === 0, a.missing.length + ' 条悬空');
  const kinds = new Set(latch.nodeArray.map(n => String(n.type)));
  check('latch.json 用到的元件类型都被支持',
    Array.from(kinds).every(k => ['0', '1', 'Import', 'Export', 'SEL'].includes(k)), Array.from(kinds).join(','));
  const selPorts = new Set(latch.linkArray.filter(l => l.frompid).map(l => String(l.frompid)));
  check('latch.json 用到的端口都存在', Array.from(selPorts).every(p => ['OUT', 'SI', 'SO', 'N', 'P', '0', '1'].includes(p)),
    Array.from(selPorts).join(','));
})();

/* ================================================================ 结果 */
console.log('\n' + '─'.repeat(62));
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`${passed} 项通过，${failures.length} 项失败：`);
  failures.forEach(f => console.log('  ✗ ' + f.name));
  process.exit(1);
}
