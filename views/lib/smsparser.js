exports.parseNum = function (raw) {
    if (raw === '' || raw === null || raw === undefined) {
        return NaN;
    }
    return Number(raw);
};

exports.parseField = function (type, raw, prev) {
    switch (type) {
    case 'number':
        return exports.parseNum(raw);
    case 'string':
        return raw;
    case 'year':
        return raw;
    case 'month':
        return raw;
    case 'date':
        var val = prev || new Date(0);
        val.setDate(raw);
        return val;
    default:
        throw new Error('Unknown field type: ' + type);
    }
};

var zip = function (a, b) {
    var zipped = [];
    var len = Math.max(a.length, b.length);
    for (var i = 0; i < len; i++) {
        zipped[i] = [a[i], b[i]];
    }
    return zipped;
};

/*
 * Return parsed object.
 */
exports.parse = function (def, doc) {
    var parts = doc.message.split('#'),
        header = parts[0].split('!'),
        name = header[1],
        vals = parts.slice(1);

    vals.unshift(header[2]);

    var pairs = zip(def, vals);

    return pairs.reduce(function (obj, v) {
        var d = v[0];
        // the fields sent_timestamp and from are set by the gateway, so they
        // are not included in the message.
        if (d.key === 'sent_timestamp') {
            v[1] = doc.sent_timestamp;
        }
        if (d.key === 'from') {
            v[1] = doc.from;
        }
        obj[d.key] = exports.parseField(d.type, v[1], obj[d.key]);
        return obj;
    }, {});
};

exports.parseArray = function (def, doc) {
    var obj = exports.parse(def, doc);
    var keys = [];
    for (var i = 0; i < def.length; i++) {
        if (keys.indexOf(def[i].key) === -1) {
            keys.push(def[i].key);
        }
    }
    var arr = [];
    for (var k = 0; k < keys.length; k++) {
        arr.push(obj[keys[k]]);
    }
    return arr;
};
