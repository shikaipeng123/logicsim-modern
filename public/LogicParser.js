/* ==========================================================================
 * LogicSim 2.0 · LogicParser.js
 * 逻辑表达式的解析与建模内核
 *
 * 本文件分四层：
 *   1) 连接词层 —— 把逻辑连接词统一表示成「条件选择树」
 *   2) 解析层   —— parseRPN（逆波兰，兼容 2021 原版）+ parseInfix（中缀，新增）
 *   3) 建模层   —— ModelGen（沿用原版算法，未作修改）
 *   4) 分析层   —— 变量收集、求值、真值表、可读化还原
 *
 * ---------------------------------------------------------------------------
 * 【核心中间表示：条件选择树】
 *
 *      { S: 条件, "0": 条件为假时的取值, "1": 条件为真时的取值 }
 *
 *   - S 既可以是变量名，也可以是另一棵子树（例如「a 推出 b」的条件就是整个 a 子树）
 *   - "0" / "1" 两个分支可以是子树，也可以是常量字符串 '0' / '1'
 *
 *  一棵条件选择树恰好对应一个 2 选 1 选择器：S 接选择端，两个分支接两路数据输入。
 *  所以「把表达式编译成选择器电路」= 把表达式规约成条件选择树，再把树画成 SEL 连线。
 *
 *  该表示法是 2021 原版程序的定义，本文件保持完全兼容，
 *  并且下面 5 个基础连接词与原版 andM/orM/notM/infM/equalM 的构造逐字一致。
 * ========================================================================== */
(function (global) {
    'use strict';

    var TRUE = '1';
    var FALSE = '0';

    function isConstant(v) {
        return v === TRUE || v === FALSE;
    }

    /* =====================================================================
     * 1. 逻辑连接词
     * ===================================================================== */

    var CONNECTIVES = {
        not: {
            arity: 1, symbol: '¬', label: '非', prec: 6,
            build: function (a) {
                return { S: a, "0": TRUE, "1": FALSE };
            }
        },
        and: {
            arity: 2, symbol: '∧', label: '与', prec: 5,
            build: function (a, b) {
                return { S: a, "0": FALSE, "1": { S: b, "0": FALSE, "1": TRUE } };
            }
        },
        nand: {
            arity: 2, symbol: '↑', label: '与非', prec: 5,
            build: function (a, b) {
                return { S: a, "0": TRUE, "1": { S: b, "0": TRUE, "1": FALSE } };
            }
        },
        or: {
            arity: 2, symbol: '∨', label: '或', prec: 4,
            build: function (a, b) {
                return { S: a, "0": { S: b, "0": FALSE, "1": TRUE }, "1": TRUE };
            }
        },
        nor: {
            arity: 2, symbol: '↓', label: '或非', prec: 4,
            build: function (a, b) {
                return { S: a, "0": { S: b, "0": TRUE, "1": FALSE }, "1": FALSE };
            }
        },
        xor: {
            arity: 2, symbol: '⊕', label: '异或', prec: 3,
            build: function (a, b) {
                return { S: a, "0": { S: b, "0": FALSE, "1": TRUE }, "1": { S: b, "0": TRUE, "1": FALSE } };
            }
        },
        implies: {
            arity: 2, symbol: '→', label: '推出', prec: 2, rightAssoc: true,
            build: function (a, b) {
                return { S: a, "0": TRUE, "1": { S: b, "0": FALSE, "1": TRUE } };
            }
        },
        xnor: {
            arity: 2, symbol: '↔', label: '等价', prec: 1,
            build: function (a, b) {
                return {
                    S: a,
                    "0": { S: b, "0": TRUE, "1": FALSE },
                    "1": { S: b, "0": FALSE, "1": TRUE }
                };
            }
        },
        /* 量词在建模层面就是折叠：∀ 折叠成与，∃ 折叠成或 */
        forall: {
            arity: -1, symbol: '∀', label: '合取量词', prec: 7, fold: 'and',
            build: function () { throw new Error('forall 通过折叠构建，不使用 build'); }
        },
        exists: {
            arity: -1, symbol: '∃', label: '析取量词', prec: 7, fold: 'or',
            build: function () { throw new Error('exists 通过折叠构建，不使用 build'); }
        }
    };

    /* =====================================================================
     * 2. 解析层
     * ===================================================================== */

    function ok(tree, ast) {
        return { ok: true, tree: tree, ast: ast };
    }

    function fail(message) {
        return { ok: false, error: message };
    }

    /* 中间结果：同时携带「选择树」与「可读语法树」 */
    function makeOperand(tree, ast) {
        return { tree: tree, ast: ast };
    }

    function applyConnective(op, operands) {
        var args = operands.map(function (o) { return o.tree; });
        var build = CONNECTIVES[op].build.apply(null, args);
        return makeOperand(build, { op: op, args: operands.map(function (o) { return o.ast; }) });
    }

    function applyFold(op, operands) {
        var foldOp = CONNECTIVES[op].fold;
        var acc = operands[0];
        for (var i = 1; i < operands.length; i++) {
            acc = applyConnective(foldOp, [acc, operands[i]]);
        }
        return makeOperand(acc.tree, { op: op, args: operands.map(function (o) { return o.ast; }) });
    }

    /* ---------------------------------------------------------------
     * 2.1 逆波兰（后缀）解析
     *
     * 记号：
     *   .  与      ,  或      <  非      >  推出      =  等价（同或）
     *   ^  异或
     * 此外还接受单词形式的运算符：and or not xor nand nor implies xnor
     *
     * 与原版相比的三处必要修正：
     *   1. 原版在表达式「项多于一个」时会直接把最后一个操作数当成结果返回
     *      （例如 "a b" 会返回字符串 "b"，被上层误当成错误信息显示）
     *   2. 原版要求名称与运算符之间必须有空格，本版把「紧邻运算符」视为名称结束
     *   3. 增加对空表达式 / 只剩多余项的明确错误提示
     * --------------------------------------------------------------- */

    var RPN_SYMBOLS = {
        '.': 'and',
        ',': 'or',
        '<': 'not',
        '>': 'implies',
        '=': 'xnor',
        '^': 'xor'
    };

    var RPN_WORDS = {
        and: 'and', or: 'or', not: 'not',
        xor: 'xor', nand: 'nand', nor: 'nor',
        implies: 'implies', imp: 'implies', xnor: 'xnor', equiv: 'xnor'
    };

    function parseRPN(text) {
        if (text === null || text === undefined || String(text).trim() === '') {
            return fail('表达式为空。请先输入一个逆波兰逻辑表达式，例如：a b . fe >');
        }

        var tokens = String(text).split(/([.,<>=^]|\s+)/);
        var stack = [];
        var readingName = false;

        function closeName() {
            if (readingName) { readingName = false; }
        }

        for (var i = 0; i < tokens.length; i++) {
            var tk = tokens[i];
            if (tk === undefined || tk === '') { continue; }

            /* 空白：结束当前名称 */
            if (/^\s+$/.test(tk)) { closeName(); continue; }

            /* 运算符 */
            var op = RPN_SYMBOLS[tk];
            if (!op && /^[A-Za-z]+$/.test(tk)) {
                op = RPN_WORDS[tk.toLowerCase()];
            }
            if (op) {
                closeName();
                var arity = CONNECTIVES[op].arity;
                if (stack.length < arity) {
                    return fail('运算符「' + tk + '」（' + CONNECTIVES[op].label + '）缺少操作数：' +
                        '需要 ' + arity + ' 个，实际只找到 ' + stack.length + ' 个');
                }
                var operands = stack.splice(stack.length - arity, arity);
                stack.push(applyConnective(op, operands));
                continue;
            }

            /* 变量名或常量 */
            if (readingName) { closeName(); }
            readingName = true;
            var lower = tk.toLowerCase();
            if (isConstant(tk)) {
                stack.push(makeOperand(tk, { const: tk }));
            } else {
                stack.push(makeOperand(tk, { variable: tk }));
            }
        }

        if (stack.length === 0) {
            return fail('没有解析出任何内容，请检查输入。');
        }
        if (stack.length > 1) {
            return fail('缺少运算符：有 ' + stack.length + ' 个项没有被合并（' +
                stack.map(function (o) { return operandName(o); }).join('、') + '）。' +
                '逆波兰写法里每个运算符都要写在它的操作数后面。');
        }
        return ok(stack[0].tree, stack[0].ast);
    }

    function operandName(o) {
        if (o.ast && o.ast.variable) { return o.ast.variable; }
        if (o.ast && o.ast.const) { return o.ast.const; }
        return '（子表达式）';
    }

    /* 兼容 2021 原版接口：成功返回选择树，失败返回错误字符串 */
    function LogicParser(npn) {
        var res = parseRPN(npn);
        return res.ok ? res.tree : res.error;
    }

    /* ---------------------------------------------------------------
     * 2.2 中缀解析（新增）
     * --------------------------------------------------------------- */

    var INFIX_SYMBOLS = [
        /* 3 字符 */
        ['<->', 'xnor'], ['<=>', 'xnor'],
        /* 2 字符 */
        ['->', 'implies'],
        ['&&', 'and'], ['||', 'or'], ['==', 'xnor'],
        /* 1 字符 */
        ['↔', 'xnor'], ['≡', 'xnor'],
        ['→', 'implies'], ['⇒', 'implies'],
        ['⊕', 'xor'], ['^', 'xor'],
        ['∨', 'or'], ['|', 'or'], ['+', 'or'],
        ['↓', 'nor'],
        ['∧', 'and'], ['&', 'and'], ['·', 'and'], ['⋅', 'and'],
        ['↑', 'nand'],
        ['¬', 'not'], ['!', 'not'], ['~', 'not']
    ].sort(function (a, b) { return b[0].length - a[0].length; });

    var INFIX_WORDS = {
        and: 'and', or: 'or', not: 'not',
        xor: 'xor', nand: 'nand', nor: 'nor',
        implies: 'implies', imp: 'implies', xnor: 'xnor', equiv: 'xnor'
    };

    var BINARY_PREC = {
        xnor: 1, implies: 2, xor: 3, or: 4, nor: 4, and: 5, nand: 5
    };

    var WORD_RE = /^[\p{L}\p{N}_]+/u;

    function tokenizeInfix(text) {
        var tokens = [];
        var i = 0;
        var n = text.length;

        while (i < n) {
            var ch = text[i];

            if (/\s/.test(ch)) { i++; continue; }

            if (ch === '(' || ch === '（') { tokens.push(tok('lparen', i, ch)); i++; continue; }
            if (ch === ')' || ch === '）') { tokens.push(tok('rparen', i, ch)); i++; continue; }
            if (ch === ',' || ch === '，' || ch === '、') { tokens.push(tok('comma', i, ch)); i++; continue; }
            if (ch === '∀') { tokens.push(tok('forall', i, ch)); i++; continue; }
            if (ch === '∃') { tokens.push(tok('exists', i, ch)); i++; continue; }
            if (ch === '⊤') { tokens.push(tok('const', i, ch, TRUE)); i++; continue; }
            if (ch === '⊥') { tokens.push(tok('const', i, ch, FALSE)); i++; continue; }

            var sym = matchSymbol(text, i);
            if (sym) { tokens.push(opTok(i, sym[0], sym[1])); i += sym[0].length; continue; }

            var m = WORD_RE.exec(text.slice(i));
            if (m) {
                var word = m[0];
                var low = word.toLowerCase();
                if (low === 'true') { tokens.push(tok('const', i, word, TRUE)); }
                else if (low === 'false') { tokens.push(tok('const', i, word, FALSE)); }
                else if (INFIX_WORDS[low]) { tokens.push(opTok(i, word, INFIX_WORDS[low])); }
                else if (isConstant(word)) { tokens.push(tok('const', i, word, word)); }
                else { tokens.push(tok('id', i, word, word)); }
                i += word.length;
                continue;
            }

            throw parseError('无法识别的字符「' + ch + '」', i);
        }

        tokens.push(tok('eof', n, ''));
        return tokens;
    }

    function tok(type, pos, text, value) {
        return { type: type, pos: pos, text: text, value: value };
    }

    /* 运算符记号单独放一个构造函数：op 字段不能塞进 value，否则解析器读不到 */
    function opTok(pos, text, op) {
        return { type: 'op', pos: pos, text: text, op: op, value: op };
    }

    function matchSymbol(text, i) {
        for (var k = 0; k < INFIX_SYMBOLS.length; k++) {
            var pair = INFIX_SYMBOLS[k];
            if (text.substr(i, pair[0].length) === pair[0]) { return pair; }
        }
        return null;
    }

    function parseError(message, pos) {
        var e = new Error(message);
        e.__parse = true;
        e.pos = pos;
        return e;
    }

    function parseInfix(text) {
        var src = text === null || text === undefined ? '' : String(text);
        if (src.trim() === '') {
            return fail('表达式为空。请先输入一个逻辑表达式，例如：(a ∧ b) → fe');
        }

        var tokens;
        try {
            tokens = tokenizeInfix(src);
        } catch (e) {
            if (e.__parse) { return fail(e.message); }
            throw e;
        }

        var idx = 0;

        function peek() { return tokens[idx]; }

        function advance() { return tokens[idx++]; }

        function describe(t) {
            if (!t) { return '表达式结束'; }
            if (t.type === 'eof') { return '表达式结束'; }
            if (t.type === 'lparen') { return '（'; }
            if (t.type === 'rparen') { return '）'; }
            if (t.type === 'comma') { return '，'; }
            if (t.type === 'const') { return t.text; }
            if (t.type === 'id') { return t.text; }
            return t.text || t.type;
        }

        function at(t) {
            return '第 ' + (t.pos + 1) + ' 个字符处';
        }

        function expect(type, what) {
            var t = peek();
            if (t.type !== type) {
                throw parseError(at(t) + '期望' + what + '，实际遇到「' + describe(t) + '」', t.pos);
            }
            return advance();
        }

        function canStartPrimary(t) {
            return t.type === 'lparen' || t.type === 'const' ||
                t.type === 'id' || t.type === 'forall' || t.type === 'exists' ||
                (t.type === 'op' && t.op === 'not');
        }

        function parseQuantifier(qt) {
            expect('lparen', '左括号「(」；量词后面需要用括号列出取值范围，例如 ∀(a, b, c)');
            if (peek().type === 'rparen') {
                throw parseError('量词「' + qt.text + '」后面至少要写一个项', peek().pos);
            }

            var items = [];
            for (; ;) {
                items.push(parseExpression(0));

                var t = peek();
                if (t.type === 'comma') {
                    advance();
                    if (peek().type === 'rparen') { break; }
                    continue;
                }
                if (t.type === 'rparen') { break; }
                if (canStartPrimary(t)) { continue; }   /* 允许空格分隔 */
                throw parseError(at(t) + '期望「,」或「)」，实际遇到「' + describe(t) + '」', t.pos);
            }
            expect('rparen', '右括号「)」');

            return applyFold(qt.type, items);
        }

        function parsePrimary() {
            var t = advance();

            if (t.type === 'lparen') {
                var inner = parseExpression(0);
                expect('rparen', '右括号「)」');
                return inner;
            }
            if (t.type === 'const') { return makeOperand(t.value, { const: t.value }); }
            if (t.type === 'id') { return makeOperand(t.value, { variable: t.value }); }
            if (t.type === 'forall' || t.type === 'exists') { return parseQuantifier(t); }

            throw parseError(at(t) + '出现了意外的「' + describe(t) + '」', t.pos);
        }

        function parseUnary() {
            var t = peek();
            if (t.type === 'op' && t.op === 'not') {
                advance();
                return applyConnective('not', [parseUnary()]);
            }
            return parsePrimary();
        }

        function parseExpression(minPrec) {
            var left = parseUnary();
            for (; ;) {
                var t = peek();
                if (t.type !== 'op') { break; }
                var prec = BINARY_PREC[t.op];
                if (prec === undefined || prec < minPrec) { break; }
                advance();
                var rightMin = CONNECTIVES[t.op].rightAssoc ? prec : prec + 1;
                var right = parseExpression(rightMin);
                left = applyConnective(t.op, [left, right]);
            }
            return left;
        }

        try {
            var result = parseExpression(0);
            var last = peek();
            if (last.type !== 'eof') {
                throw parseError(at(last) + '还有无法解析的内容「' + describe(last) + '」', last.pos);
            }
            return ok(result.tree, result.ast);
        } catch (e) {
            if (e.__parse) { return fail(e.message); }
            throw e;
        }
    }

    /* ---------------------------------------------------------------
     * 2.3 统一入口
     * --------------------------------------------------------------- */
    function parse(text, mode) {
        return mode === 'rpn' ? parseRPN(text) : parseInfix(text);
    }

    /* =====================================================================
     * 3. ModelGen —— 建模层
     *
     * 以下函数与 2021 原版逐字一致，未作任何修改。
     * 作用：把「条件选择树」规约成按变量组织的判定表示
     *   { value: [ { ".": "<"|">", 变量名: "<"|">" , ... } ], order: [变量名...] }
     * 其中每条 value 记录表示「按 order 里列出的变量取值时，函数取常量 0（"<"）还是常量 1（">"）」，
     * 并在过程中完成常量折叠（例如 a ∨ ¬a 会被直接化简为常量 1）。
     * ===================================================================== */
    function ModelGen(np) {
        /* 0:"<"
           1:">" */
        var result = {
            value: [],
            order: []
        };
        if ("string" == typeof (np)) {
            if ("1" == np) {
                result.value = [{ ".": ">" }];
                result.order = [];
            } else if ("0" == np) {
                result.value = [{ ".": "<" }];
                result.order = [];
            } else {
                var temp1 = { ".": ">" };
                var temp2 = { ".": "<" };
                temp1[np] = ">";
                temp2[np] = "<";
                result.value = [temp1, temp2];
                result.order = [np];
            }

        }
        else {
            var result1 = ModelGen(np.S);

            if (0 == result1.order.length) {
                if ("<" == result1.value[0]["."]) {
                    result = ModelGen(np[0]);
                } else {
                    result = ModelGen(np[1]);
                }
            }
            else {
                var myset = new Set(result1.order);

                var result2 = ModelGen(np[0]);
                var intersection2 = result2.order.filter(x => myset.has(x));

                var result3 = ModelGen(np[1]);
                var intersection3 = result3.order.filter(x => myset.has(x));

                var all0 = false;
                var all1 = false;

                for (let x of result1.value) {
                    if ("<" == x["."]) {
                        for (let y of result2.value) {
                            var YesOrNot = true;
                            for (let z of intersection2) {
                                if (undefined != x[z] && undefined != y[z] && x[z] != y[z]) {
                                    YesOrNot = false;
                                    break;
                                }
                            };
                            if (YesOrNot) {
                                var newValue = {};
                                for (var k in x) {
                                    var item = x[k];
                                    newValue[k] = item;
                                }
                                for (let alpha of result2.order) {
                                    if (undefined != y[alpha]) {
                                        newValue[alpha] = y[alpha];
                                    }
                                };
                                newValue["."] = y["."];
                                if (">" == newValue["."]) {
                                    all1 = true;
                                } else {
                                    all0 = true;
                                };
                                result.value.push(newValue);
                            }
                        }
                    }
                    else {
                        for (let y of result3.value) {
                            var YesOrNot = true;
                            for (let z of intersection3) {
                                if (undefined != x[z] && undefined != y[z] && x[z] != y[z]) {
                                    YesOrNot = false;
                                    break;
                                }
                            };
                            if (YesOrNot) {
                                var newValue = {};
                                for (var k in x) {
                                    var item = x[k];
                                    newValue[k] = item;
                                }
                                for (let alpha of result3.order) {
                                    if (undefined != y[alpha]) {
                                        newValue[alpha] = y[alpha];
                                    }
                                };
                                newValue["."] = y["."];
                                if (">" == newValue["."]) {
                                    all1 = true;
                                } else {
                                    all0 = true;
                                };
                                result.value.push(newValue);
                            }
                        }
                    }
                };
                if (all0 && !all1) {
                    result = {
                        value: [{ ".": "<" }],
                        order: []
                    }
                } else if (all1 && !all0) {
                    result = {
                        value: [{ ".": ">" }],
                        order: []
                    }
                }
                else {
                    var tempOrder = new Set(
                        result1.order.concat(result2.order).concat(result3.order)
                    );
                    result.order = Array.from(tempOrder);
                }
            }
        }
        return result;
    }

    /* =====================================================================
     * 4. 分析层
     * ===================================================================== */

    function collectVars(tree, out) {
        out = out || new Set();
        if (typeof tree === 'string') {
            if (!isConstant(tree)) { out.add(tree); }
            return out;
        }
        collectVars(tree.S, out);
        collectVars(tree["0"], out);
        collectVars(tree["1"], out);
        return out;
    }

    function evalTree(tree, env) {
        if (typeof tree === 'string') {
            if (isConstant(tree)) { return tree; }
            return env[tree] === TRUE ? TRUE : FALSE;
        }
        var cond = evalTree(tree.S, env);
        return evalTree(cond === TRUE ? tree["1"] : tree["0"], env);
    }

    var MAX_TRUTH_VARS = 12;

    function truthTable(tree, options) {
        options = options || {};
        var limit = options.maxVars || MAX_TRUTH_VARS;
        var vars = Array.from(collectVars(tree)).sort();

        if (vars.length > limit) {
            return {
                ok: true, truncated: true, vars: vars,
                varCount: vars.length, rows: [], total: Math.pow(2, vars.length)
            };
        }

        var rows = [];
        var ones = [];
        var total = Math.pow(2, vars.length);

        for (var m = 0; m < total; m++) {
            var env = {};
            var bits = '';
            for (var j = 0; j < vars.length; j++) {
                var value = ((m >> (vars.length - 1 - j)) & 1) ? TRUE : FALSE;
                env[vars[j]] = value;
                bits += value;
            }
            var out = evalTree(tree, env);
            if (out === TRUE) { ones.push(m); }
            rows.push({ index: m, bits: bits, out: out });
        }

        var classification = 'contingent';
        if (ones.length === total) { classification = 'tautology'; }
        else if (ones.length === 0) { classification = 'contradiction'; }

        return {
            ok: true, truncated: false, vars: vars, varCount: vars.length,
            rows: rows, total: total, ones: ones,
            oneCount: ones.length, classification: classification,
            minterms: ones
        };
    }

    /* 把可读语法树还原成中缀字符串，便于用户确认解析结果 */
    function astToInfix(ast, parentPrec) {
        if (parentPrec === undefined) { parentPrec = 0; }
        if (!ast) { return ''; }
        if (ast.const !== undefined) { return ast.const; }
        if (ast.variable !== undefined) { return ast.variable; }

        var def = CONNECTIVES[ast.op];
        var text;

        if (ast.op === 'forall' || ast.op === 'exists') {
            text = def.symbol + '(' + ast.args.map(function (a) { return astToInfix(a, 0); }).join(', ') + ')';
        } else if (ast.op === 'not') {
            text = def.symbol + astToInfix(ast.args[0], def.prec);
        } else {
            var prec = def.prec;
            var left = astToInfix(ast.args[0], prec + 1);
            var right = astToInfix(ast.args[1], def.rightAssoc ? prec : prec + 1);
            text = left + ' ' + def.symbol + ' ' + right;
        }

        if (def.prec < parentPrec) { return '(' + text + ')'; }
        return text;
    }

    function collectOperators(ast, counts) {
        counts = counts || {};
        if (!ast) { return counts; }
        if (ast.op) {
            counts[ast.op] = (counts[ast.op] || 0) + 1;
            ast.args.forEach(function (a) { collectOperators(a, counts); });
        }
        return counts;
    }

    /* =====================================================================
     * 对外导出
     * ===================================================================== */
    global.LogicSim = {
        version: '2.0.0',
        TRUE: TRUE,
        FALSE: FALSE,
        CONNECTIVES: CONNECTIVES,
        isConstant: isConstant,
        parse: parse,
        parseRPN: parseRPN,
        parseInfix: parseInfix,
        applyConnective: applyConnective,
        ModelGen: ModelGen,
        collectVars: function (tree) { return Array.from(collectVars(tree)).sort(); },
        evalTree: evalTree,
        truthTable: truthTable,
        astToInfix: astToInfix,
        collectOperators: collectOperators,
        maxTruthVars: MAX_TRUTH_VARS
    };

    /* 兼容原版全局接口 */
    global.LogicParser = LogicParser;
    global.ModelGen = ModelGen;

})(typeof window !== 'undefined' ? window : this);
