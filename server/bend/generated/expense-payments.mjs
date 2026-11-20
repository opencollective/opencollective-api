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

function $has_expenses_scope(_e_0) {
  const _scope_0 = _e_0["has_expenses_scope"];
  return _scope_0;
}

function $type_of(_e_0) {
  const _expense_type_0 = _e_0["expense_type"];
  return _expense_type_0;
}

function $is_manually_created_charge(_e_0) {
  const _manual_0 = _e_0["manually_created_charge"];
  return _manual_0;
}

function $status_of(_e_0) {
  const _status_0 = _e_0["status"];
  return _status_0;
}

function $can_use_expenses(_e_0) {
  const _can_use_0 = _e_0["can_use_expenses"];
  return _can_use_0;
}

function $is_blocked_for_unpaid_billing(_h_0) {
  const _blocked_0 = _h_0["blocked_for_unpaid_billing"];
  return _blocked_0;
}

function $is_authenticated(_h_0) {
  const _authenticated_0 = _h_0["authenticated"];
  return _authenticated_0;
}

function $is_host_admin(_h_0) {
  const _host_admin_0 = _h_0["host_admin"];
  return _host_admin_0;
}

function $is_charge(_t_0) {
  if (_t_0.$ === "Charge") {
    return true;
  } else {
    return false;
  }
}

function $is_platform_expense(_t_0) {
  if (_t_0.$ === "Settlement") {
    return true;
  } else if (_t_0.$ === "PlatformBilling") {
    return true;
  } else {
    return false;
  }
}

function $is_payable_status(_s_0) {
  if (_s_0.$ === "Approved") {
    return true;
  } else if (_s_0.$ === "Error") {
    return true;
  } else {
    return false;
  }
}

function $screen_checks(_scope_0, _card_charge_0, _payable_0, _can_use_0) {
  if (!_scope_0) {
    return {$: "Deny", "reason": {$: "InvalidScope"}};
  } else {
    if (_card_charge_0) {
      return {$: "Deny", "reason": {$: "ChargeNotPayable"}};
    } else {
      if (!_payable_0) {
        return {$: "Deny", "reason": {$: "UnsupportedStatus"}};
      } else {
        if (!_can_use_0) {
          return {$: "Deny", "reason": {$: "UserFeatureDisabled"}};
        } else {
          return {$: "Allow"};
        }
      }
    }
  }
}

function $screen(_e_0) {
  const _scope_0 = _e_0["has_expenses_scope"];
  const _expense_type_0 = _e_0["expense_type"];
  const _manual_0 = _e_0["manually_created_charge"];
  const _status_0 = _e_0["status"];
  const _can_use_0 = _e_0["can_use_expenses"];
  return $screen_checks(_scope_0, $$Bool_and($$is_charge(_expense_type_0), $$Bool_not(_manual_0)), $$is_payable_status(_status_0), _can_use_0);
}

function $host_checks(_blocked_0, _authenticated_0, _host_admin_0) {
  if (_blocked_0) {
    return {$: "Deny", "reason": {$: "HostBlocked"}};
  } else {
    if (!_authenticated_0) {
      return {$: "Deny", "reason": {$: "UserRequired"}};
    } else {
      if (!_host_admin_0) {
        return {$: "Deny", "reason": {$: "NotHostAdmin"}};
      } else {
        return {$: "Allow"};
      }
    }
  }
}

function $check_host(_expense_type_0, _h_0) {
  const _blocked_0 = _h_0["blocked_for_unpaid_billing"];
  const _authenticated_0 = _h_0["authenticated"];
  const _host_admin_0 = _h_0["host_admin"];
  return $host_checks($$Bool_and(_blocked_0, $$Bool_not($$is_platform_expense(_expense_type_0))), _authenticated_0, _host_admin_0);
}

function $after_screening(_screening_0, _expense_type_0, _h_0) {
  if (_screening_0.$ === "Deny") {
    const _reason_0 = _screening_0["reason"];
    return {$: "Deny", "reason": _reason_0};
  } else {
    return $check_host(_expense_type_0, _h_0);
  }
}

function $mark_as_paid(_e_0, _h_0) {
  return $after_screening($$screen(_e_0), $$type_of(_e_0), _h_0);
}

function $reject_charges(_marking_0, _charge_0) {
  if (_marking_0.$ === "Deny") {
    const _reason_0 = _marking_0["reason"];
    return {$: "Deny", "reason": _reason_0};
  } else {
    if (_charge_0) {
      return {$: "Deny", "reason": {$: "ChargeNotPayable"}};
    } else {
      return {$: "Allow"};
    }
  }
}

function $pay(_e_0, _h_0) {
  return $reject_charges($$mark_as_paid(_e_0, _h_0), $$is_charge($$type_of(_e_0)));
}

function $Bool_and(_a_0, _b_0) {
  if (!_a_0) {
    return false;
  } else {
    return _b_0;
  }
}

function $Bool_not(_b_0) {
  if (!_b_0) {
    return true;
  } else {
    return false;
  }
}

const $$is_charge = $is_charge;
const $$Bool_not = $Bool_not;
const $$Bool_and = $Bool_and;
const $$is_payable_status = $is_payable_status;
const $$is_platform_expense = $is_platform_expense;
const $$screen = $screen;
const $$type_of = $type_of;
const $$mark_as_paid = $mark_as_paid;export default {
  "has_expenses_scope": run_lib((a0) => run_loop($has_expenses_scope(a0)), 1),
  "type_of": run_lib((a0) => run_loop($type_of(a0)), 1),
  "is_manually_created_charge": run_lib((a0) => run_loop($is_manually_created_charge(a0)), 1),
  "status_of": run_lib((a0) => run_loop($status_of(a0)), 1),
  "can_use_expenses": run_lib((a0) => run_loop($can_use_expenses(a0)), 1),
  "is_blocked_for_unpaid_billing": run_lib((a0) => run_loop($is_blocked_for_unpaid_billing(a0)), 1),
  "is_authenticated": run_lib((a0) => run_loop($is_authenticated(a0)), 1),
  "is_host_admin": run_lib((a0) => run_loop($is_host_admin(a0)), 1),
  "is_charge": run_lib((a0) => run_loop($is_charge(a0)), 1),
  "is_platform_expense": run_lib((a0) => run_loop($is_platform_expense(a0)), 1),
  "is_payable_status": run_lib((a0) => run_loop($is_payable_status(a0)), 1),
  "screen_checks": run_lib((a0,a1,a2,a3) => run_loop($screen_checks(a0,a1,a2,a3)), 4),
  "screen": run_lib((a0) => run_loop($screen(a0)), 1),
  "host_checks": run_lib((a0,a1,a2) => run_loop($host_checks(a0,a1,a2)), 3),
  "check_host": run_lib((a0,a1) => run_loop($check_host(a0,a1)), 2),
  "after_screening": run_lib((a0,a1,a2) => run_loop($after_screening(a0,a1,a2)), 3),
  "mark_as_paid": run_lib((a0,a1) => run_loop($mark_as_paid(a0,a1)), 2),
  "reject_charges": run_lib((a0,a1) => run_loop($reject_charges(a0,a1)), 2),
  "pay": run_lib((a0,a1) => run_loop($pay(a0,a1)), 2),
};
