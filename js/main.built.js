!function () {
    function t(e, r, o) {
        function n(s, a) {
            if (!r[s]) {
                if (!e[s]) {
                    var c = "function" == typeof require && require;
                    if (!a && c) return c(s, !0);
                    if (i) return i(s, !0);
                    var l = new Error("Cannot find module '" + s + "'");
                    throw l.code = "MODULE_NOT_FOUND", l
                }
                var u = r[s] = {exports: {}};
                e[s][0].call(u.exports, function (t) {
                    var r = e[s][1][t];
                    return n(r || t)
                }, u, u.exports, t, e, r, o)
            }
            return r[s].exports
        }

        for (var i = "function" == typeof require && require, s = 0; s < o.length; s++) n(o[s]);
        return n
    }

    return t
}()({
    1: [function (t, e, r) {
        "use strict";
        e.exports = {WordJoiner: t("./ac-kr-word-joiner/WordJoiner")}
    }, {"./ac-kr-word-joiner/WordJoiner": 2}], 2: [function (t, e, r) {
        "use strict";

        function o(t) {
            this.options = s(l, t), this._treeWalkers = [], this.rootElements = []
        }

        var n = t("./isOnlyWhitespace"), i = t("./createTreeWalker"), s = t("@marcom/ac-object/defaults"), a = "â ",
            c = null, l = {dataAttribute: "data-word-join", joinerCharacter: a, contextElement: document},
            u = o.prototype;
        o.joinify = function (t, e) {
            var r = "", o = 0, i = t.length;
            for (e = e || a; o < i;) r += t[o], o < i - 1 && !n(t[o + 1]) && !n(t[o]) && (r += e), o += 1;
            return r
        }, o.shouldJoin = function () {
            if (null !== c) return c;
            c = !1;
            var t = document.createElement("div");
            return "querySelectorAll" in document && "wordBreak" in t.style && (t.style.wordBreak = "keep-all", "keep-all" !== t.style.wordBreak && (c = !0)), t = null, c
        }, u.destroy = function () {
            this._treeWalkers && this._treeWalkers.length > 0 && this._treeWalkers.forEach(function (t) {
                t = null
            }), this._treeWalkers = null, this.rootElements = null, this.options = null
        }, u.getRootElements = function (t, e) {
            t = t || this.options.dataAttribute, e = e || this.options.contextElement;
            var r, o = "body";
            return t && (o = "[" + t + "]"), r = [].slice.call(e.querySelectorAll(o))
        }, u.join = function () {
            0 === this.rootElements.length && (this.rootElements = this.getRootElements(), this._treeWalkers = this._createTreeWalkers()), this._treeWalkers && this._treeWalkers.length > 0 && this._treeWalkers.forEach(function (t) {
                for (var e = t.nextNode(); e;) e.data = o.joinify(e.data, this.options.joinerCharacter), e = t.nextNode()
            }, this)
        }, u._createTreeWalkers = function () {
            var t = [];
            return this.rootElements && this.rootElements.length > 0 && this.rootElements.forEach(function (e) {
                t.push(i(e))
            }, this), t
        }, e.exports = o
    }, {"./createTreeWalker": 3, "./isOnlyWhitespace": 4, "@marcom/ac-object/defaults": 5}], 3: [function (t, e, r) {
        "use strict";

        function o(t) {
            var e = document.createTreeWalker(t, NodeFilter.SHOW_TEXT, {
                acceptNode: function (t) {
                    if (!n(t.data) && t.data.length > 1) return NodeFilter.FILTER_ACCEPT
                }
            }, !1);
            return e
        }

        var n = t("./isOnlyWhitespace");
        e.exports = o
    }, {"./isOnlyWhitespace": 4}], 4: [function (t, e, r) {
        "use strict";

        function o(t) {
            return /^\s*$/.test(t)
        }

        e.exports = o
    }, {}], 5: [function (t, e, r) {
        "use strict";
        var o = t("./extend");
        e.exports = function (t, e) {
            if ("object" != typeof t) throw new TypeError("defaults: must provide a defaults object");
            if (e = e || {}, "object" != typeof e) throw new TypeError("defaults: options must be a typeof object");
            return o({}, t, e)
        }
    }, {"./extend": 6}], 6: [function (t, e, r) {
        "use strict";
        t("@marcom/ac-polyfills/Array/prototype.forEach");
        var o = Object.prototype.hasOwnProperty;
        e.exports = function () {
            var t, e;
            return t = arguments.length < 2 ? [{}, arguments[0]] : [].slice.call(arguments), e = t.shift(), t.forEach(function (t) {
                if (null != t) for (var r in t) o.call(t, r) && (e[r] = t[r])
            }), e
        }
    }, {"@marcom/ac-polyfills/Array/prototype.forEach": void 0}], 7: [function (t, e, r) {
        "use strict";
        var o = t("@marcom/ac-kr-word-joiner").WordJoiner, n = function () {
            return {
                initialize: function () {
                    this.krWordJoiner()
                }, krWordJoiner: function () {
                    var t, e = document.documentElement.getAttribute("lang");
                    "ko-KR" === e && o.shouldJoin() && (t = new o({dataAttribute: !1}), t.join(), t.destroy())
                }
            }
        }();
        e.exports = n.initialize()
    }, {"@marcom/ac-kr-word-joiner": 1}]
}, {}, [7]);