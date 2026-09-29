/* ==========================================================================
 * LogicSim 2.0 · App.js
 * 界面与交互层：画布渲染、真值表、导出、主题、本地持久化
 *
 * 分工：
 *   LogicParser.js  纯逻辑：解析 + 建模 + 分析
 *   ViewGen.js      纯数据：判定表示 → 电路图 JSON
 *   App.js（本文件）DOM / JointJS / 交互
 * ========================================================================== */
(function () {
    'use strict';

    var LogicSim = window.LogicSim;
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var STORAGE_KEY = 'logicsim2.state.v1';

    /* =================================================================
     * 0. DOM 引用
     * ================================================================= */
    var el = {};
    [
        'exprInput', 'modeSwitch', 'btnParse', 'btnClear', 'parseHint', 'examples',
        'legendInfix', 'legendRpn',
        'btnZoomIn', 'btnZoomOut', 'btnFit', 'zoomLabel', 'btnExportSvg', 'btnExportPng',
        'graphArea', 'paper', 'mini-paper', 'mini-view', 'minimap', 'miniHint', 'canvasEmpty',
        'sideTabs', 'statVars', 'statNodes', 'statLinks', 'statOnes', 'verdict', 'truthTable',
        'modelJson', 'btnJsonToGraph', 'btnGraphToJson', 'fileToLoad', 'btnDownloadJson',
        'inspectHint', 'erType', 'erName', 'erMemo', 'btnApplyName',
        'status', 'statusDot', 'toast', 'btnTheme', 'btnHelp', 'helpDialog', 'btnHelpOk', 'btnHelpClose'
    ].forEach(function (id) { el[id] = document.getElementById(id); });

    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    /* =================================================================
     * 1. 应用状态
     * ================================================================= */
    var state = {
        mode: 'infix',
        theme: 'light',
        model: { nodeArray: [], linkArray: [] },
        tree: null,
        ast: null,
        stats: null,
        selectedId: null,
        lastError: null
    };

    var graph = null;
    var paper = null;
    var miniPaper = null;

    /* =================================================================
     * 2. 图标：预加载成 data URL，让导出的 SVG / PNG 自包含
     * ================================================================= */
    var ICON_FILES = {
        '0': 'assets/zero.svg',
        '1': 'assets/one.svg',
        'Import': 'assets/input.svg',
        'Export': 'assets/output.svg',
        'SEL': 'assets/SEL.svg'
    };
    var iconHref = {};

    function preloadIcons() {
        /* 用 file:// 直接打开时 fetch 会被浏览器拦下，此时退化为相对路径，
           画布照常显示（只是导出的 PNG 里图标会缺失）。 */
        return Promise.all(Object.keys(ICON_FILES).map(function (kind) {
            var path = ICON_FILES[kind];
            return fetch(path)
                .then(function (res) {
                    if (!res.ok) { throw new Error(String(res.status)); }
                    return res.text();
                })
                .then(function (text) {
                    iconHref[kind] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
                })
                .catch(function () { iconHref[kind] = path; });
        }));
    }

    /* =================================================================
     * 3. 提示与状态栏
     * ================================================================= */
    var toastTimer = null;

    function toast(message, tone) {
        el.toast.textContent = message;
        el.toast.className = 'toast' + (tone === 'err' ? ' toast--err' : tone === 'ok' ? ' toast--ok' : '');
        el.toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3200);
    }

    function setStatus(message, tone) {
        el.status.textContent = message;
        el.statusDot.className = 'statusbar__dot' + (tone ? ' is-' + tone : '');
    }

    function showHint(message, tone) {
        if (!message) {
            el.parseHint.hidden = true;
            el.parseHint.textContent = '';
            return;
        }
        el.parseHint.hidden = false;
        el.parseHint.textContent = message;
        el.parseHint.className = 'alert' + (tone === 'ok' ? ' alert--ok' : tone === 'warn' ? ' alert--warn' : '');
    }

    /* =================================================================
     * 4. 主题
     * ================================================================= */
    function applyTheme(theme, options) {
        state.theme = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', state.theme);
        if (paper) {
            paintCanvas();
            if (options && options.rerender === false) { /* 只换配色 */ }
            rebuildGraph();
        }
        persist();
    }

    function paintCanvas() {
        if (!paper) { return; }
        paper.options.drawGrid = {
            name: 'dot',
            args: { color: cssVar('--grid'), thickness: 1 }
        };
        paper.drawGrid();
    }

    /* =================================================================
     * 5. 画布初始化
     * ================================================================= */
    function initPaper() {
        graph = new joint.dia.Graph();

        paper = new joint.dia.Paper({
            el: el['paper'],
            model: graph,
            width: 640,
            height: 420,
            gridSize: 10,
            drawGrid: { name: 'dot', args: { color: cssVar('--grid'), thickness: 1 } },
            background: { color: 'transparent' },
            interactive: { linkMove: false, vertexAdd: false },
            snapLinks: true,
            markAvailable: true
        });

        miniPaper = new joint.dia.Paper({
            el: el['mini-paper'],
            model: graph,
            width: 220,
            height: 140,
            background: { color: 'transparent' },
            interactive: false
        });

        miniPaper.on('cell:pointerdown', function () { /* 小地图不参与交互 */ });

        paper.on({
            'blank:pointerdown': onCanvasPointerDown,
            'blank:pointerdblclick': clearSelection,
            'element:pointerdown': function (elementView) { selectElement(elementView.model.id); },
            'element:mouseenter': function (elementView) {
                if (!joint.elementTools) { return; }
                elementView.addTools(new joint.dia.ToolsView({
                    tools: [
                        new joint.elementTools.Remove({ useModelGeometry: true, x: '100%', y: '0%' }),
                        new joint.elementTools.Boundary({ focusOpacity: 0.35, padding: 8, useModelGeometry: true })
                    ]
                }));
            },
            'link:mouseenter': function (linkView) {
                if (!joint.linkTools) { return; }
                linkView.addTools(new joint.dia.ToolsView({
                    tools: [
                        new joint.linkTools.Remove({ useModelGeometry: true, x: '100%', y: '0%' }),
                        new joint.linkTools.Boundary({ focusOpacity: 0.35, padding: 3, useModelGeometry: true })
                    ]
                }));
            },
            'cell:mouseleave': function (cellView) { cellView.removeTools(); },
            'element:pointerclick': function (elementView) { selectElement(elementView.model.id); }
        });

        el.graphArea.addEventListener('wheel', onWheel, { passive: false });
    }

    function onWheel(event) {
        event.preventDefault();
        var rect = paper.el.getBoundingClientRect();
        var factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
    }

    function currentScale() {
        var s = paper.scale();
        return s && s.sx ? s.sx : 1;
    }

    function updateZoomLabel() {
        el.zoomLabel.textContent = Math.round(currentScale() * 100) + '%';
    }

    function zoomAt(px, py, factor) {
        var s0 = currentScale();
        var t = paper.translate();
        var s1 = Math.min(8, Math.max(0.1, s0 * factor));
        if (Math.abs(s1 - s0) < 1e-6) { return; }
        var localX = (px - t.tx) / s0;
        var localY = (py - t.ty) / s0;
        paper.scale(s1, s1);
        paper.translate(px - s1 * localX, py - s1 * localY);
        updateZoomLabel();
        syncMinimapViewport();
    }

    function zoomCenter(factor) {
        zoomAt(paper.options.width / 2, paper.options.height / 2, factor);
    }

    function fitView(options) {
        if (!graph || graph.getCells().length === 0) {
            el.canvasEmpty.hidden = false;
            return;
        }
        el.canvasEmpty.hidden = true;
        paper.scaleContentToFit({ padding: options && options.padding !== undefined ? options.padding : 60, maxScale: 1.6 });
        updateZoomLabel();
        syncMinimapViewport();
    }

    /* ---------- 平移 ---------- */
    var dragOrigin = null;

    function onCanvasPointerDown(event) {
        var startX = event.clientX;
        var startY = event.clientY;
        var startTranslate = paper.translate();

        function move(evt) {
            paper.translate(
                startTranslate.tx + (evt.clientX - startX),
                startTranslate.ty + (evt.clientY - startY)
            );
            syncMinimapViewport();
        }

        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        }

        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    /* =================================================================
     * 6. 小地图
     * ================================================================= */
    function sizePapers() {
        var area = el.graphArea.getBoundingClientRect();
        var w = Math.max(240, Math.round(area.width));
        var h = Math.max(180, Math.round(area.height));
        if (paper.options.width !== w || paper.options.height !== h) {
            paper.setDimensions(w, h);
        }

        var mw = Math.max(80, el.minimap.clientWidth);
        var mh = Math.max(60, el.minimap.clientHeight);
        if (miniPaper.options.width !== mw || miniPaper.options.height !== mh) {
            miniPaper.setDimensions(mw, mh);
        }
    }

    function refreshMinimap() {
        if (!graph || graph.getCells().length === 0) {
            el['mini-view'].style.display = 'none';
            return;
        }
        el['mini-view'].style.display = 'block';
        miniPaper.scaleContentToFit({ padding: 10, maxScale: 1 });
        syncMinimapViewport();
    }

    /* 把主画布的可见区域映射成小地图上的一个矩形 */
    function syncMinimapViewport() {
        if (!graph || graph.getCells().length === 0) { return; }
        var box = el['mini-paper'].getBoundingClientRect();
        if (!box.width || !box.height) { return; }

        var area = el.graphArea.getBoundingClientRect();
        var local = paper.clientToLocalRect(area.left, area.top, area.width, area.height);
        var p1 = miniPaper.localToPaperPoint(local.x, local.y);
        var p2 = miniPaper.localToPaperPoint(local.x + local.width, local.y + local.height);

        var left = Math.min(p1.x, p2.x);
        var top = Math.min(p1.y, p2.y);
        var width = Math.abs(p2.x - p1.x);
        var height = Math.abs(p2.y - p1.y);

        /* 可见范围大于画布内容时，夹到小地图边界内 */
        if (left < 0) { width += left; left = 0; }
        if (top < 0) { height += top; top = 0; }
        if (left + width > box.width) { width = box.width - left; }
        if (top + height > box.height) { height = box.height - top; }

        var view = el['mini-view'].style;
        view.left = Math.round(Math.max(0, left)) + 'px';
        view.top = Math.round(Math.max(0, top)) + 'px';
        view.width = Math.round(Math.max(8, width)) + 'px';
        view.height = Math.round(Math.max(8, height)) + 'px';
    }

    function initMinimapInteraction() {
        var dragging = false;

        function centerOn(clientX, clientY) {
            var box = el['mini-paper'].getBoundingClientRect();
            var local = miniPaper.paperToLocalPoint(clientX - box.left, clientY - box.top);
            var s = currentScale();
            paper.translate(paper.options.width / 2 - s * local.x, paper.options.height / 2 - s * local.y);
            syncMinimapViewport();
        }

        el.minimap.addEventListener('mousedown', function (event) {
            /* 提示文字是 pointer-events:none，所以这里不必再挑目标 */
            event.preventDefault();
            dragging = true;
            centerOn(event.clientX, event.clientY);
        });

        window.addEventListener('mousemove', function (event) {
            if (!dragging) { return; }
            event.preventDefault();
            centerOn(event.clientX, event.clientY);
        });

        window.addEventListener('mouseup', function () { dragging = false; });
    }

    /* =================================================================
     * 7. 元件与连线
     * ================================================================= */
    var NODE_SIZE = 96;

    var KIND_META = {
        '0': { accent: '--node-const0', caption: 'Zero' },
        '1': { accent: '--node-const1', caption: 'One' },
        'Import': { accent: '--node-input', caption: 'Import' },
        'Export': { accent: '--node-output', caption: 'Export' },
        'SEL': { accent: '--node-sel', caption: '' }
    };

    var PORT_ITEMS = {
        '0': [{ group: 'out', id: 'OUT', attrs: { portLabel: { text: 'OUT' } } }],
        '1': [{ group: 'out', id: 'OUT', attrs: { portLabel: { text: 'OUT' } } }],
        'Import': [{ group: 'out', id: 'OUT', attrs: { portLabel: { text: 'OUT' } } }],
        'Export': [{ group: 'in', id: 'OUT', attrs: { portLabel: { text: 'OUT' } } }],
        'SEL': [
            { group: 'in', id: 'SI', attrs: { portLabel: { text: 'SI' } } },
            { group: 'in', id: '0', attrs: { portLabel: { text: '0' } } },
            { group: 'in', id: '1', attrs: { portLabel: { text: '1' } } },
            { group: 'out', id: 'SO', attrs: { portLabel: { text: 'SO' } } },
            { group: 'out', id: 'N', attrs: { portLabel: { text: 'N' } } },
            { group: 'out', id: 'P', attrs: { portLabel: { text: 'P' } } }
        ]
    };

    function portGroups() {
        var dim = cssVar('--text-dim');
        var body = { width: 10, height: 10, x: -5, y: -5, rx: 3, ry: 3, fill: dim, stroke: 'none' };
        var label = { fill: dim, fontSize: 10.5, fontWeight: 500, fontFamily: 'ui-monospace, monospace' };
        return {
            in: {
                position: { name: 'left' },
                attrs: {
                    portBody: Object.assign({ magnet: true }, body),
                    portLabel: Object.assign({}, label, { x: 8, y: 3, textAnchor: 'start' })
                },
                markup: [
                    { tagName: 'rect', selector: 'portBody' },
                    { tagName: 'text', selector: 'portLabel' }
                ]
            },
            out: {
                position: { name: 'right' },
                attrs: {
                    portBody: Object.assign({ magnet: true }, body),
                    portLabel: Object.assign({}, label, { x: -8, y: 3, textAnchor: 'end' })
                },
                markup: [
                    { tagName: 'rect', selector: 'portBody' },
                    { tagName: 'text', selector: 'portLabel' }
                ]
            }
        };
    }

    function makeNode(key, kind, displayName) {
        var meta = KIND_META[kind] || KIND_META['SEL'];
        var accent = cssVar(meta.accent);
        var nameFirst = (kind === 'Import' || kind === 'Export');

        var nameFont = nameFirst ? 15 : 10;
        var nameY = nameFirst ? 10 : 26;
        var titleFont = nameFirst ? 10 : 17;
        var titleY = nameFirst ? 28 : 8;

        /* 变量名可能是汉字，用系统 CJK 字体栈；0/1/SEL 这类符号用等宽字体，
           避免 CJK 字体把阿拉伯数字替换成形近的汉字数字 */
        var monoFont = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        var varFont = cssVar('--var-font') || 'system-ui, sans-serif';
        var nameFontFamily = (kind === 'Import') ? varFont : monoFont;

        return new joint.shapes.standard.Rectangle({
            id: String(key),
            kind: kind,                                  /* 连接类型单独保存，改名不会破坏它 */
            displayName: kind === 'SEL' ? '' : (displayName || ''),
            size: { width: NODE_SIZE, height: NODE_SIZE },
            attrs: {
                body: {
                    width: '100%', height: '100%', rx: 13, ry: 13,
                    fill: accent, stroke: cssVar('--node-stroke'), strokeWidth: 1
                },
                icon: {
                    'xlink:href': iconHref[kind] || '',
                    /* 和文字一样用 refX/refY 的百分比基准，否则 x/y 会被当成绝对坐标，
                       图标就会跑到节点外面去 */
                    refX: '50%', refY: '50%',
                    x: -14, y: -34, width: 28, height: 28
                },
                /* title 显示「类型」侧的文字，name 里存模型的 name 字段 */
                label: {
                    text: kind === 'SEL' ? 'SEL' : kind,
                    refX: '50%', refY: '50%', x: 0, y: titleY,
                    textAnchor: 'middle', textVerticalAnchor: 'middle',
                    fontSize: titleFont, fontWeight: 600,
                    fontFamily: monoFont,
                    fill: cssVar('--node-label'),
                    textWrap: { width: -14, height: -6, ellipsis: true }
                },
                name: {
                    text: kind === 'SEL' ? '' : (displayName || meta.caption),
                    refX: '50%', refY: '50%', x: 0, y: nameY,
                    textAnchor: 'middle', textVerticalAnchor: 'middle',
                    fontSize: nameFont, fontWeight: nameFirst ? 600 : 400,
                    fontFamily: nameFontFamily,
                    fill: nameFirst ? cssVar('--node-label') : cssVar('--node-caption'),
                    textWrap: { width: -14, height: -4, ellipsis: true }
                }
            },
            markup: [
                { tagName: 'rect', selector: 'body' },
                { tagName: 'image', selector: 'icon' },
                { tagName: 'text', selector: 'label' },
                { tagName: 'text', selector: 'name' }
            ],
            ports: { groups: portGroups(), items: PORT_ITEMS[kind] || [] }
        });
    }

    function makeLink(link) {
        var color = cssVar('--link');
        return new joint.shapes.standard.Link({
            source: { id: String(link.from), magnet: 'portBody', port: String(link.frompid) },
            target: { id: String(link.to), magnet: 'portBody', port: String(link.topid) },
            attrs: {
                line: {
                    connection: true,
                    stroke: color,
                    strokeWidth: 1.6,
                    strokeLinejoin: 'round',
                    targetMarker: { type: 'path', d: 'M 9 -4 0 0 9 4 Z', fill: color, stroke: 'none' }
                }
            },
            connector: { name: 'jumpover', args: { size: 4 } },
            router: {
                name: 'metro',
                args: { step: 8, startDirections: ['right'], endDirections: ['left'] }
            }
        });
    }

    function buildCells(model) {
        var cells = [];
        (model.nodeArray || []).forEach(function (node) {
            cells.push(makeNode(node.key, String(node.type), node.name));
        });
        (model.linkArray || []).forEach(function (link) {
            cells.push(makeLink(link));
        });
        return cells;
    }

    /* 画布 → 模型 */
    function dumpGraph() {
        var result = { nodeArray: [], linkArray: [] };
        graph.getCells().forEach(function (cell) {
            if (cell.get('type') === 'standard.Link') {
                var source = cell.get('source') || {};
                var target = cell.get('target') || {};
                result.linkArray.push({
                    from: source.id, frompid: source.port,
                    to: target.id, topid: target.port
                });
                return;
            }
            var kind = String(cell.get('kind') || cell.attr('label/text') || '');
            var entry = { key: cell.id, type: kind };
            if (kind !== 'SEL') {
                entry.name = cell.get('displayName') !== undefined && cell.get('displayName') !== ''
                    ? cell.get('displayName')
                    : (cell.attr('name/text') || '');
            }
            result.nodeArray.push(entry);
        });
        return result;
    }

    /* 给 SEL 节点补上「选择变量」的显示（纯展示，不进入模型） */
    function annotateSelectors() {
        graph.getCells().forEach(function (cell) {
            if (cell.get('kind') !== 'SEL') { return; }
            var incoming = graph.getLinks().filter(function (link) {
                return String(link.get('target').id) === String(cell.id) &&
                    link.get('target').port === 'SI';
            });
            var text = '';
            if (incoming.length) {
                var source = graph.getCell(incoming[0].get('source').id);
                if (source) { text = source.attr('name/text') || source.get('kind') || ''; }
            }
            cell.attr('name/text', text ? '选择 ' + text : '');
        });
    }

    function rebuildGraph(options) {
        if (!graph) { return; }
        options = options || {};
        graph.resetCells(buildCells(state.model));

        if (graph.getCells().length) {
            try {
                joint.layout.DirectedGraph.layout(graph, {
                    setLinkVertices: false,
                    nodeSep: 70,
                    edgeSep: 40,
                    rankSep: 90,
                    rankDir: 'LR'
                });
            } catch (e) {
                /* 存在环（例如手写的锁存器模型）时 dagre 可能报错，忽略即可 */
            }
        }

        annotateSelectors();
        el.canvasEmpty.hidden = graph.getCells().length > 0;
        sizePapers();
        fitView();
        refreshMinimap();
        updateStats();
        clearSelection();
        persist();
    }

    /* =================================================================
     * 8. 解析与出图
     * ================================================================= */
    function applyExpression() {
        var text = el.exprInput.value;
        var parsed = LogicSim.parse(text, state.mode);

        if (!parsed.ok) {
            state.tree = null;
            state.ast = null;
            state.lastError = parsed.error;
            state.model = { nodeArray: [], linkArray: [] };
            el.modelJson.value = JSON.stringify(state.model, null, 2);
            renderTruthTable(null);
            rebuildGraph();
            showHint(parsed.error);
            setStatus('解析失败', 'err');
            toast('解析失败，请看左侧提示', 'err');
            return false;
        }

        state.tree = parsed.tree;
        state.ast = parsed.ast;

        var built;
        try {
            built = LogicSim.ViewGen(LogicSim.ModelGen(parsed.tree));
        } catch (e) {
            showHint('生成电路时出错：' + (e && e.message ? e.message : e));
            setStatus('生成失败', 'err');
            return false;
        }

        state.model = built;
        el.modelJson.value = JSON.stringify(built, null, 2);
        showHint('已解析：' + LogicSim.astToInfix(parsed.ast), 'ok');
        setStatus('解析成功，已生成电路', 'ok');
        renderTruthTable(parsed.tree);
        rebuildGraph();
        return true;
    }

    /* =================================================================
     * 9. 真值表
     * ================================================================= */
    function renderTruthTable(tree) {
        var table = el.truthTable;
        table.innerHTML = '';

        if (!tree) {
            el.statVars.textContent = '—';
            el.statOnes.textContent = '—';
            el.verdict.hidden = true;
            return;
        }

        var analysis = LogicSim.truthTable(tree);
        el.statVars.textContent = analysis.varCount;

        if (analysis.truncated) {
            el.statOnes.textContent = '—';
            el.verdict.hidden = false;
            el.verdict.className = 'verdict verdict--warn';
            el.verdict.textContent = '变量有 ' + analysis.varCount + ' 个，合起来 ' + analysis.total +
                ' 行，超过 ' + LogicSim.maxTruthVars + ' 个变量的展示上限，所以没有列表。电路图仍然正常生成。';
            return;
        }

        el.statOnes.textContent = analysis.oneCount + ' / ' + analysis.total;

        el.verdict.hidden = false;
        if (analysis.classification === 'tautology') {
            el.verdict.className = 'verdict verdict--ok';
            el.verdict.textContent = '恒真式：所有 ' + analysis.total + ' 种取值下结果都是 1。';
        } else if (analysis.classification === 'contradiction') {
            el.verdict.className = 'verdict verdict--warn';
            el.verdict.textContent = '矛盾式：所有取值下结果都是 0，电路会化简成常量 0。';
        } else {
            el.verdict.className = 'verdict';
            el.verdict.textContent = '可满足式：' + analysis.oneCount + ' 种取值下为 1，' +
                (analysis.total - analysis.oneCount) + ' 种为 0。最小项 Σm(' + analysis.minterms.join(', ') + ')';
        }

        var thead = document.createElement('thead');
        var headRow = document.createElement('tr');
        headRow.appendChild(th('#'));

        if (analysis.vars.length === 0) {
            headRow.appendChild(th('常量'));
        } else {
            analysis.vars.forEach(function (v) { headRow.appendChild(th(v)); });
        }
        headRow.appendChild(th('结果'));
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        analysis.rows.forEach(function (row) {
            var tr = document.createElement('tr');
            var idx = document.createElement('td');
            idx.className = 'rowidx';
            idx.textContent = row.index;
            tr.appendChild(idx);

            if (analysis.vars.length === 0) {
                var only = document.createElement('td');
                only.textContent = '—';
                tr.appendChild(only);
            } else {
                row.bits.split('').forEach(function (bit) {
                    var td = document.createElement('td');
                    td.textContent = bit;
                    tr.appendChild(td);
                });
            }

            var out = document.createElement('td');
            out.className = 'out ' + (row.out === '1' ? 'is-one' : 'is-zero');
            out.textContent = row.out;
            tr.appendChild(out);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
    }

    function th(text) {
        var node = document.createElement('th');
        node.textContent = text;
        return node;
    }

    function updateStats() {
        var stats = LogicSim.graphStats(state.model);
        state.stats = stats;
        el.statNodes.textContent = stats.nodes;
        el.statLinks.textContent = stats.links;
    }

    /* =================================================================
     * 10. 图模型面板
     * ================================================================= */
    function jsonToGraph() {
        var text = el.modelJson.value;
        var parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            showHint('图模型 JSON 解析失败：' + e.message);
            toast('JSON 格式有误', 'err');
            setStatus('JSON 格式有误', 'err');
            return;
        }
        if (!parsed || !Array.isArray(parsed.nodeArray) || !Array.isArray(parsed.linkArray)) {
            showHint('图模型需要同时包含 nodeArray 与 linkArray 两个数组。');
            toast('图模型结构不完整', 'err');
            return;
        }
        state.model = parsed;
        rebuildGraph();
        setStatus('已按 JSON 重建画布', 'ok');
        toast('文本转图完成', 'ok');
    }

    function graphToJson() {
        state.model = dumpGraph();
        el.modelJson.value = JSON.stringify(state.model, null, 2);
        updateStats();
        setStatus('已把画布同步回 JSON', 'ok');
        toast('图形转文本完成', 'ok');
        persist();
    }

    function downloadJson() {
        downloadBlob(
            new Blob([JSON.stringify(state.model, null, 2)], { type: 'application/json' }),
            'logicsim-model.json'
        );
    }

    function loadModelFile(file) {
        var reader = new FileReader();
        reader.onload = function (evt) {
            el.modelJson.value = String(evt.target.result);
            jsonToGraph();
        };
        reader.readAsText(file, 'UTF-8');
    }

    /* =================================================================
     * 11. 画布导出
     * ================================================================= */
    function buildExportSvg() {
        var svg = paper.el.querySelector('svg');
        if (!svg) { return null; }

        var clone = svg.cloneNode(true);

        var bbox;
        try { bbox = paper.getContentBBox(); } catch (e) { bbox = null; }
        if (!bbox || !bbox.width || !bbox.height) {
            bbox = { x: 0, y: 0, width: paper.options.width, height: paper.options.height };
        }

        var pad = 28;
        var x = Math.round(bbox.x - pad);
        var y = Math.round(bbox.y - pad);
        var w = Math.round(bbox.width + pad * 2);
        var h = Math.round(bbox.height + pad * 2);

        /* 去掉网格、选中外框等交互层 */
        ['.grid', '.tools', '.joint-tools'].forEach(function (selector) {
            Array.prototype.forEach.call(clone.querySelectorAll(selector), function (node) {
                node.parentNode.removeChild(node);
            });
        });

        clone.setAttribute('xmlns', SVG_NS);
        clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
        clone.setAttribute('width', w);
        clone.setAttribute('height', h);
        clone.setAttribute('viewBox', x + ' ' + y + ' ' + w + ' ' + h);

        var background = document.createElementNS(SVG_NS, 'rect');
        background.setAttribute('x', x);
        background.setAttribute('y', y);
        background.setAttribute('width', w);
        background.setAttribute('height', h);
        background.setAttribute('fill', cssVar('--canvas-bg'));
        clone.insertBefore(background, clone.firstChild);

        var style = document.createElementNS(SVG_NS, 'style');
        style.textContent = 'text{font-family:' + cssVar('--sans').replace(/"/g, "'") + '}';
        clone.insertBefore(style, background.nextSibling);

        return '<?xml version="1.0" encoding="UTF-8"?>\n' +
            new XMLSerializer().serializeToString(clone);
    }

    function exportSvg() {
        if (!ensureExportable()) { return; }
        var text = buildExportSvg();
        if (!text) { toast('没有可导出的内容', 'err'); return; }
        downloadBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), 'logicsim-circuit.svg');
        toast('已导出 SVG', 'ok');
    }

    function exportPng() {
        if (!ensureExportable()) { return; }
        var text = buildExportSvg();
        if (!text) { toast('没有可导出的内容', 'err'); return; }

        var url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
        var image = new Image();

        image.onload = function () {
            var scale = 2;
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            var ctx = canvas.getContext('2d');
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            ctx.drawImage(image, 0, 0, image.width, image.height);
            URL.revokeObjectURL(url);

            canvas.toBlob(function (blob) {
                if (!blob) { toast('PNG 生成失败', 'err'); return; }
                downloadBlob(blob, 'logicsim-circuit.png');
                toast('已导出 PNG（2 倍分辨率）', 'ok');
            }, 'image/png');
        };

        image.onerror = function () {
            URL.revokeObjectURL(url);
            toast('PNG 导出失败：浏览器无法栅格化这张 SVG', 'err');
        };

        image.src = url;
    }

    function ensureExportable() {
        if (!graph || graph.getCells().length === 0) {
            toast('画布是空的，先解析一个表达式', 'err');
            return false;
        }
        return true;
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    /* =================================================================
     * 12. 选中与改名
     * ================================================================= */
    /* 选中外框用的高亮器。JointJS 的裁剪版发行包里没有 highlighters，
       所以这里允许它缺失——缺了只是没有虚线外框，功能不受影响。 */
    var maskHighlighter = (joint.highlighters && joint.highlighters.mask) || null;

    function highlightSelected(cell, on) {
        if (!maskHighlighter || !cell) { return; }
        var view = paper.findViewByModel(cell);
        if (!view) { return; }
        try {
            if (on) {
                maskHighlighter.add(view, 'body', 'selected', {
                    attrs: { stroke: cssVar('--accent'), strokeWidth: 2, 'stroke-dasharray': '5 3' }
                });
            } else {
                maskHighlighter.remove(view);
            }
        } catch (e) { /* 高亮失败不影响主流程 */ }
    }

    function selectElement(id) {
        clearSelection();
        state.selectedId = String(id);
        var cell = graph.getCell(state.selectedId);
        if (!cell) { return; }

        highlightSelected(cell, true);

        var kind = String(cell.get('kind') || '');
        el.erType.value = kind || '—';
        el.inspectHint.textContent = kind === 'SEL'
            ? '选择器（2 选 1）：选择端 ' + (cell.attr('name/text') || '未记录') + '。选择器的名称取自连线，不能直接改。'
            : '正在编辑「' + kind + '」元件，改完记得点「保存修改」。';
        el.erName.value = cell.get('displayName') || cell.attr('name/text') || '';
        el.erName.disabled = kind === 'SEL';
        el.erMemo.value = cell.attr('label/memo') || '';

        el.sideTabs.querySelectorAll('button').forEach(function (button) {
            if (button.dataset.tab === 'inspect') { button.click(); }
        });
    }

    function clearSelection() {
        if (state.selectedId) {
            highlightSelected(graph.getCell(state.selectedId), false);
        }
        state.selectedId = null;
    }

    function applyNameChange() {
        if (!state.selectedId) { toast('先在画布上点选一个元件', 'err'); return; }
        var cell = graph.getCell(state.selectedId);
        if (!cell) { return; }

        var text = el.erName.value;
        var memo = el.erMemo.value;
        var kind = String(cell.get('kind') || '');

        if (kind !== 'SEL') {
            cell.set('displayName', text);
            cell.attr('name/text', text || KIND_META[kind].caption);
        }
        cell.attr('label/memo', memo);

        graphToJson();
        toast('已保存修改', 'ok');
    }

    /* =================================================================
     * 13. 示例
     * ================================================================= */
    var EXAMPLES = [
        { label: 'a ∧ b', mode: 'infix', text: 'a ∧ b' },
        { label: '(a ∧ b) → fe', mode: 'infix', text: '(a ∧ b) → fe' },
        { label: 'a ⊕ b ⊕ c', mode: 'infix', text: 'a ⊕ b ⊕ c' },
        { label: 'a ∨ ¬a （恒真）', mode: 'infix', text: 'a ∨ ¬a' },
        { label: '∀(a, b, c) → ∃(a, b)', mode: 'infix', text: '∀(a, b, c) → ∃(a, b)' },
        { label: 'a ↑ b （与非）', mode: 'infix', text: 'a ↑ b' },
        { label: '(a ↔ b) ∧ (c → d)', mode: 'infix', text: '(a ↔ b) ∧ (c → d)' },
        { label: '逆波兰: a b . fe >', mode: 'rpn', text: 'a b . fe >' },
        { label: '逆波兰: a b . fe ge > =', mode: 'rpn', text: 'a b . fe ge > =' },
        { label: '锁存器（手写模型）', model: {
            nodeArray: [
                { key: '0', type: '0', name: 'Zero' },
                { key: 1, type: '1', name: 'One' },
                { key: 2, type: 'Export', name: 'Out' },
                { key: 'a', type: 'Import', name: '保持' },
                { key: 'b', type: 'Import', name: '载入位' },
                { key: 3, type: 'SEL' },
                { key: 4, type: 'SEL' }
            ],
            linkArray: [
                { from: 3, frompid: 'SO', to: 2, topid: 'OUT' },
                { from: 'a', frompid: 'OUT', to: 4, topid: 'SI' },
                { from: 'b', frompid: 'OUT', to: 4, topid: '0' },
                { from: 1, frompid: 'OUT', to: 3, topid: '1' },
                { from: '0', frompid: 'OUT', to: 3, topid: '0' },
                { from: 4, frompid: 'N', to: 3, topid: 'SI' },
                { from: 3, frompid: 'N', to: 4, topid: '1' }
            ]
        } }
    ];

    function renderExamples() {
        el.examples.innerHTML = '';
        EXAMPLES.forEach(function (example) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip';
            button.textContent = example.label;
            button.addEventListener('click', function () { useExample(example); });
            el.examples.appendChild(button);
        });
    }

    function useExample(example) {
        if (example.model) {
            state.mode = example.mode || state.mode;
            setMode(state.mode);
            state.model = JSON.parse(JSON.stringify(example.model));
            el.modelJson.value = JSON.stringify(state.model, null, 2);
            state.tree = null;
            state.ast = null;
            renderTruthTable(null);
            showHint('这是一个手写的图模型示例，可以直接在「图模型」标签页里改，或者点「图形转文本」。', 'ok');
            setStatus('已载入示例：' + example.label, 'ok');
            rebuildGraph();
            return;
        }
        setMode(example.mode);
        el.exprInput.value = example.text;
        applyExpression();
    }

    /* =================================================================
     * 14. 模式切换
     * ================================================================= */
    function setMode(mode) {
        state.mode = mode === 'rpn' ? 'rpn' : 'infix';
        el.modeSwitch.querySelectorAll('button').forEach(function (button) {
            button.classList.toggle('is-active', button.dataset.mode === state.mode);
        });
        el.legendInfix.hidden = state.mode !== 'infix';
        el.legendRpn.hidden = state.mode !== 'rpn';
        el.exprInput.placeholder = state.mode === 'rpn'
            ? '例如： a b . fe >　（记号之间用空格分开）'
            : '例如： (a ∧ b) → fe　或　∀(a, b, c) → ∃(a, b)';
        persist();
    }

    /* =================================================================
     * 15. 本地持久化
     * ================================================================= */
    var persistTimer = null;

    function persist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(function () {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    mode: state.mode,
                    theme: state.theme,
                    text: el.exprInput.value,
                    model: state.model,
                    modelJson: el.modelJson.value
                }));
            } catch (e) { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
        }, 250);
    }

    function restore() {
        var raw;
        try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
        if (!raw) { return false; }
        var saved;
        try { saved = JSON.parse(raw); } catch (e) { return false; }

        applyTheme(saved.theme || 'light');
        setMode(saved.mode || 'infix');

        if (saved.text) {
            el.exprInput.value = saved.text;
        }
        if (saved.model && Array.isArray(saved.model.nodeArray)) {
            state.model = saved.model;
            el.modelJson.value = saved.modelJson || JSON.stringify(saved.model, null, 2);
            updateStats();
            return true;
        }
        return false;
    }

    /* =================================================================
     * 16. 事件绑定
     * ================================================================= */
    function bindEvents() {
        el.btnParse.addEventListener('click', applyExpression);
        el.btnClear.addEventListener('click', function () {
            el.exprInput.value = '';
            showHint('');
            el.exprInput.focus();
            persist();
        });

        el.exprInput.addEventListener('keydown', function (event) {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                applyExpression();
            }
        });
        el.exprInput.addEventListener('input', persist);

        el.modeSwitch.addEventListener('click', function (event) {
            var button = event.target.closest('button');
            if (button && button.dataset.mode) { setMode(button.dataset.mode); }
        });

        el.btnZoomIn.addEventListener('click', function () { zoomCenter(1.2); });
        el.btnZoomOut.addEventListener('click', function () { zoomCenter(1 / 1.2); });
        el.btnFit.addEventListener('click', function () { fitView(); refreshMinimap(); });

        el.btnExportSvg.addEventListener('click', exportSvg);
        el.btnExportPng.addEventListener('click', exportPng);

        el.sideTabs.addEventListener('click', function (event) {
            var button = event.target.closest('button');
            if (!button || !button.dataset.tab) { return; }
            el.sideTabs.querySelectorAll('button').forEach(function (item) {
                item.classList.toggle('is-active', item === button);
            });
            document.querySelectorAll('.tabpane').forEach(function (pane) {
                pane.classList.toggle('is-active', pane.dataset.pane === button.dataset.tab);
            });
            if (button.dataset.tab === 'truth') { syncMinimapViewport(); }
        });

        el.btnJsonToGraph.addEventListener('click', jsonToGraph);
        el.btnGraphToJson.addEventListener('click', graphToJson);
        el.btnDownloadJson.addEventListener('click', downloadJson);
        el.fileToLoad.addEventListener('change', function (event) {
            if (event.target.files && event.target.files[0]) { loadModelFile(event.target.files[0]); }
            event.target.value = '';
        });

        el.btnApplyName.addEventListener('click', applyNameChange);

        el.btnTheme.addEventListener('click', function () {
            applyTheme(state.theme === 'dark' ? 'light' : 'dark');
        });

        el.btnHelp.addEventListener('click', function () {
            if (typeof el.helpDialog.showModal === 'function') { el.helpDialog.showModal(); }
            else { el.helpDialog.setAttribute('open', 'open'); }
        });
        function closeHelp() {
            if (typeof el.helpDialog.close === 'function') { el.helpDialog.close(); }
            else { el.helpDialog.removeAttribute('open'); }
        }
        el.btnHelpOk.addEventListener('click', closeHelp);
        el.btnHelpClose.addEventListener('click', closeHelp);
        el.helpDialog.addEventListener('click', function (event) {
            if (event.target === el.helpDialog) { closeHelp(); }
        });

        document.addEventListener('keydown', function (event) {
            if (event.altKey && event.key === '0') { event.preventDefault(); fitView(); refreshMinimap(); }
            if (event.altKey && (event.key === '=' || event.key === '+')) { event.preventDefault(); zoomCenter(1.2); }
            if (event.altKey && event.key === '-') { event.preventDefault(); zoomCenter(1 / 1.2); }
            if (event.key === 'Escape') { clearSelection(); }
        });

        var resizeTimer = null;
        var onResize = function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                sizePapers();
                syncMinimapViewport();
                if (el.graphArea.clientWidth > 0) { /* 触发一次重排 */ }
            }, 120);
        };
        window.addEventListener('resize', onResize);
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(onResize).observe(el.graphArea);
        }
    }

    /* =================================================================
     * 17. 启动
     * ================================================================= */
    function boot() {
        initPaper();
        initMinimapInteraction();
        renderExamples();
        bindEvents();

        preloadIcons().then(function () {
            var restored = restore();
            if (!restored) {
                setMode('infix');
                el.exprInput.value = '(a ∧ b) → fe';
                applyExpression();
            } else {
                sizePapers();
                rebuildGraph();
                if (state.tree === null) { showHint(''); }
            }
            setTimeout(function () { sizePapers(); fitView(); refreshMinimap(); }, 60);
        });

        setStatus('就绪', null);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
