/* ==========================================================================
 * LogicSim 2.0 · ViewGen.js
 * 图模型生成层：把建模层给出的判定表示编译成「节点 + 连线」的电路图模型
 *
 * 输出的 JSON 结构（与 2021 原版完全一致，可直接沿用旧文件）：
 *
 *   {
 *     nodeArray: [ { key, type, name? }, ... ],
 *     linkArray: [ { from, frompid, to, topid }, ... ]
 *   }
 *
 * node.type 取值：'0' 常量零 / '1' 常量一 / 'Import' 变量输入 /
 *                 'Export' 输出 / 'SEL' 2 选 1 选择器
 * SEL 的端口：输入 SI（选择端）、0、1；输出 N（选择结果）、SO、P
 *
 * 相对原版的两处修正：
 *   1. 变量名如果恰好是纯数字（例如叫 "3"），会与选择器的自动编号撞 key，
 *      这里统一给纯数字变量名加前缀 v，连线引用同步改写
 *   2. 原版用了若干未声明的隐式全局变量（for (x of ...)），这里全部改为局部变量
 * ========================================================================== */
(function (global) {
    'use strict';

    /* 自动编号从 2 开始：0/1 已被常量节点占用，2 是输出节点 */
    var FIRST_AUTO_KEY = 2;

    function keyFor(name) {
        return /^\d+$/.test(String(name)) ? 'v' + name : String(name);
    }

    function ViewGen(pn) {
        var countKey = FIRST_AUTO_KEY;

        var result = {
            nodeArray: [
                { "key": "0", "type": "0", "name": "Zero" },
                { "key": 1, "type": "1", "name": "One" },
                { "key": 2, "type": "Export", "name": "Out" }
            ],
            linkArray: []
        };

        function ViewGen0(pnp, NodeKey, PortId) {
            /* 该子式已化简为常量：直接连到常量节点 */
            if (1 === pnp.value.length) {
                if ("<" === pnp.value[0]["."]) {
                    return {
                        nodeArray: [],
                        linkArray: [{ "from": "0", "frompid": "OUT", "to": NodeKey, "topid": PortId }]
                    };
                } else {
                    return {
                        nodeArray: [],
                        linkArray: [{ "from": 1, "frompid": "OUT", "to": NodeKey, "topid": PortId }]
                    };
                }
            }

            /* 找出一个在所有记录里都出现的变量，作为这一层的选择端 */
            var CName = "";
            for (var i = 0; i < pnp.order.length; i++) {
                var candidate = pnp.order[i];
                var matched = pnp.value.filter(function (x) { return undefined != x[candidate]; }).length;
                if (pnp.value.length === matched) { CName = candidate; }
            }

            /* 理论上不会发生：建模层保证每条记录都含全部 order 变量。
               万一发生，说明上游数据异常，宁可显式报错也不要静默画错。 */
            if ("" === CName) {
                if (global.console && global.console.warn) {
                    global.console.warn('[LogicSim] ViewGen: 找不到可用的选择变量，判定表示可能被破坏。', pnp);
                }
                return undefined;
            }

            var TempOrder = pnp.order.filter(function (x) { return x !== CName; });

            var pnp1 = {
                value: pnp.value.filter(function (x) { return "<" === x[CName]; }),
                order: TempOrder
            };
            var pnp2 = {
                value: pnp.value.filter(function (x) { return ">" === x[CName]; }),
                order: TempOrder
            };

            countKey++;
            var NodeKeyNow = countKey;
            var NodeLink1 = ViewGen0(pnp1, NodeKeyNow, "0");
            var NodeLink2 = ViewGen0(pnp2, NodeKeyNow, "1");

            return {
                nodeArray: [{ "key": NodeKeyNow, "type": "SEL" }]
                    .concat(NodeLink1.nodeArray, NodeLink2.nodeArray),
                linkArray: [
                    { "from": NodeKeyNow, "frompid": "N", "to": NodeKey, "topid": PortId },
                    { "from": keyFor(CName), "frompid": "OUT", "to": NodeKeyNow, "topid": "SI" }
                ].concat(NodeLink1.linkArray, NodeLink2.linkArray)
            };
        }

        /* 变量输入节点 */
        for (var n = 0; n < pn.order.length; n++) {
            var vname = pn.order[n];
            result.nodeArray.push({ "key": keyFor(vname), "type": "Import", "name": vname });
        }

        var root = ViewGen0(pn, FIRST_AUTO_KEY, "OUT");
        if (root) {
            result.nodeArray = result.nodeArray.concat(root.nodeArray);
            result.linkArray = result.linkArray.concat(root.linkArray);
        }

        return result;
    }

    /* 统计信息，供界面显示 */
    function graphStats(model) {
        var nodes = model && model.nodeArray ? model.nodeArray : [];
        var links = model && model.linkArray ? model.linkArray : [];
        var byType = {};
        var vars = [];
        nodes.forEach(function (node) {
            var type = String(node.type);
            byType[type] = (byType[type] || 0) + 1;
            if (type === 'Import' && node.name) { vars.push(node.name); }
        });
        return {
            nodes: nodes.length,
            links: links.length,
            byType: byType,
            selectors: byType['SEL'] || 0,
            inputs: byType['Import'] || 0,
            vars: vars
        };
    }

    global.ViewGen = ViewGen;
    global.LogicSim = global.LogicSim || {};
    global.LogicSim.ViewGen = ViewGen;
    global.LogicSim.graphStats = graphStats;

})(typeof window !== 'undefined' ? window : this);
