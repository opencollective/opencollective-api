function word_to_u32(w) {
  let x = 0;
  for (let i = 0; w.$ === "WCon"; i++) {
    x |= Number(w.head) << i;
    w = w.tail;
  }
  return x >>> 0;
}

function u32_to_word(x) {
  let w = {$: "WNil"};
  for (let i = 31; i >= 0; i--) {
    w = {$: "WCon", head: ((x >>> i) & 1) === 1, tail: w};
  }
  return w;
}

function cmp_new(a, b) {
  return {$: a < b ? "LT" : a === b ? "EQ" : "GT"};
}

function tup_new(a, b) {
  return {$: "Tuple", fst: a, snd: b};
}

function nat_divmod(a, b) {
  return tup_new(b && Math.trunc(a / b), b ? a % b : a);
}

function nat_chk(n) {
  if (n > 281474976710655) {
    throw "bend: a Nat past the largest immediate 2^48-1";
  }
  return n;
}

function nat_in(n) {
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 53) {
    throw "bend: expected a Nat host number: an integer from 0 to 2^53";
  }
  return n;
}

function f32_show(x) {
  let s = "nan";
  for (let p = 1; x === x && p <= 9 && f32_round(s) !== x; p += 1) {
    s = String(Number(x.toExponential(p - 1)));
  }
  return (Object.is(x, -0) ? "-0" : s).replace("Infinity", "inf");
}

function f32_bits(x) {
  return new Uint32Array(new Float32Array([x]).buffer)[0];
}

function f32_from_bits(u) {
  return new Float32Array(new Uint32Array([u]).buffer)[0];
}

function f32_read(s) {
  const re = /^[\t\n\v\f\r ]*[+-]?((\d+(?:\.\d*)?|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i;
  return re.test(s) ? {$: "Some", value: f32_round(
    s.replace(/inf\w*/i, "Infinity"))} : {$: "None"};
}

const f32_round = function f32_round(s) {
  const d = Number(s);
  const a = Math.abs(d);
  const f = Math.fround(a);
  const g = 2 * a - Math.min(f, 2 ** 128);
  if (g === f || Math.fround(g) !== g || g === Infinity) {
    return Math.sign(d) * f;
  }
  let k = 0;
  while (a * 2 ** k % 1 !== 0) {
    k += 1;
  }
  const [, i, r, e] = /(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(s);
  const n = Number(e ?? 0) - r.length;
  const x = BigInt(i + r) * 2n ** BigInt(k) * 10n ** BigInt(Math.max(n, 0));
  const y = BigInt(a * 2 ** k) * 10n ** BigInt(Math.max(-n, 0));
  return Math.sign(d) * (x === y || x > y !== g > f ? f : g);
};

const char_new = function char_new(c) {
  return c < 55296 || c >= 57344 && c <= 1114111 ? String.fromCodePoint(c) : String.fromCharCode(56320, c >>> 22, c >>> 11 & 2047, c & 2047);
};

function char_len(s, at = 0) {
  return s[at] === "\uDC00" ? 4 : s.codePointAt(at) > 0xFFFF ? 2 : 1;
}

function char_code(s) {
  return s.length < 4 ? s.codePointAt(0)
    : (s.charCodeAt(1) << 22 | s.charCodeAt(2) << 11 | s.charCodeAt(3)) >>> 0;
}

function string_contains(s, p) {
  // A match starts at a Char, not inside a packed U32 code.
  for (let at = 0; at <= s.length; at += char_len(s, at)) {
    if (s.startsWith(p, at)) {
      return true;
    }
  }
  return false;
}

function str_out(s) {
  return s.replace(/\uDC00[^]{3}/gu, "\uFFFD");
}

function str_in(s) {
  return s.replace(/\p{Cs}/gu, "\uFFFD");
}

// Array
// =====

function array_new(d, v, lgs) {
  if (d > 31 - lgs) {
    throw "bend: an array past the deepest block class 31 (depth + log2 words per cell)";
  }
  return Array(2 ** d).fill(v);
}

function array_node(a, b) {
  if (a.length !== b.length) {
    throw "bend: runtime fail-stop";
  }
  return a.concat(b);
}

function array_rmw(a, i, f) {
  const old = a[i %= a.length];
  a[i] = f(old);
  return tup_new(a, old);
}

// Run
// ===

function run_tail(f, x) {
  return {$: "$JMP", f: f.j?.f === f ? f.j : f, x};
}

function run_clo(j) {
  const f = (x) => run_loop(j(x));
  f.j = j;
  j.f = f;
  return f;
}

function run_loop(r) {
  while (r !== null && typeof r === "object" && r.$ === "$JMP") {
    r = r.f(r.x);
  }
  return r;
}

function run_lib(f, n) {
  return (...a) => a.length < n ? run_lib((...b) => f(...a, ...b), n - a.length)
    : run_loop(f(...a));
}

// Effect
// ======

const $0eff = Object.create(null);
const io_file_append = new Set();

function io_eff(k, run) {
  if (arguments.length > 2) {
    throw new Error("bend: " + k + " takes no need: an effect that waits parks itself");
  }
  if (k in $0eff) {
    throw new Error("bend: two effects register " + k);
  }
  $0eff[k] = run;
}
// Program
// =======

function $asks_for_token(_d_0) {
  const _ask_0 = _d_0["ask_for_token"];
  return _ask_0;
}

function $paid_since_token(_d_0) {
  const _paid_0 = _d_0["paid_since_token"];
  return _paid_0;
}

function $count_or_ask(_fits_0, _total_0) {
  if (_fits_0) {
    return {$: "Decision", "ask_for_token": false, "paid_since_token": _total_0};
  } else {
    return {$: "Decision", "ask_for_token": true, "paid_since_token": 0};
  }
}

function $decide(_limit_0, _paid_0, _amount_0) {
  if (_paid_0.$ === "None") {
    return {$: "Decision", "ask_for_token": true, "paid_since_token": 0};
  } else {
    const _total_0 = _paid_0["value"];
    const _new_total_0 = nat_chk(_total_0 + _amount_0);
    return $count_or_ask($$Nat_is_le(_new_total_0, _limit_0), _new_total_0);
  }
}

function $is_within(_limit_0, _paid_0) {
  if (_paid_0.$ === "None") {
    return true;
  } else {
    const _total_0 = _paid_0["value"];
    return $Nat_is_le(_total_0, _limit_0);
  }
}

function $replay($0, $1, $2) {
  for (;;) {
    {
      const _amounts_0 = $0;
      const _limit_0 = $1;
      const _paid_0 = $2;
      if (_amounts_0.$ === "Nil") {
        return _paid_0;
      } else {
        const _amount_0 = _amounts_0["head"];
        const _rest_0 = _amounts_0["tail"];
        $0 = _rest_0;
        $1 = _limit_0;
        $2 = {$: "Some", "value": $$paid_since_token($$decide(_limit_0, _paid_0, _amount_0))};
        continue;
      }
    }
  }
}

function $Nat_is_le(_a_0, _b_0) {
  return $Cmp_is_le(cmp_new(_a_0, _b_0));
}

function $Cmp_is_le(_c_0) {
  if (_c_0.$ === "GT") {
    return false;
  } else {
    return true;
  }
}

const $$Nat_is_le = $Nat_is_le;
const $$decide = $decide;
const $$paid_since_token = $paid_since_token;export default {
  "asks_for_token": run_lib((a0) => run_loop($asks_for_token(a0)), 1),
  "paid_since_token": run_lib((a0) => run_loop($paid_since_token(a0)), 1),
  "count_or_ask": run_lib((a0,a1) => run_loop($count_or_ask(a0,nat_in(a1))), 2),
  "decide": run_lib((a0,a1,a2) => run_loop($decide(nat_in(a0),a1,nat_in(a2))), 3),
  "is_within": run_lib((a0,a1) => run_loop($is_within(nat_in(a0),a1)), 2),
  "replay": run_lib((a0,a1,a2) => run_loop($replay(a0,nat_in(a1),a2)), 3),
};
