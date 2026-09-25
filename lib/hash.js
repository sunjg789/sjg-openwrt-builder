'use strict';
// md5crypt 实现（BusyBox/musl 一定支持的 $1$ 格式）
// 与 openssl passwd -1 完全对齐，避免把明文密码写进固件。
const crypto = require('crypto');

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function to64(value, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ITOA64[value & 0x3f];
    value >>>= 6;
  }
  return out;
}

// 随机短盐（8 字符以内）
function randomSalt() {
  return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9./]/g, '').slice(0, 8);
}

function md5crypt(password, salt) {
  const magic = '$1$';
  const pw = Buffer.from(password, 'utf8');
  const sl = Buffer.from((salt || '').slice(0, 8), 'utf8');

  let ctx = crypto.createHash('md5');
  ctx.update(pw);
  ctx.update(magic);
  ctx.update(sl);

  const ctx1 = crypto.createHash('md5');
  ctx1.update(pw);
  ctx1.update(sl);
  ctx1.update(pw);
  const pwMix = ctx1.digest();

  let acc = ctx;
  for (let i = pw.length; i > 0; i -= 16) {
    acc.update(pwMix.subarray(0, i > 16 ? 16 : i));
  }

  for (let i = pw.length; i !== 0; i >>>= 1) {
    if (i & 1) acc.update(Buffer.from([0]));
    else acc.update(pw.subarray(0, 1));
  }
  let final = acc.digest();

  for (let i = 0; i < 1000; i++) {
    const c = crypto.createHash('md5');
    if (i & 1) c.update(pw);
    else c.update(final);
    if (i % 3) c.update(sl);
    if (i % 7) c.update(pw);
    if (i & 1) c.update(final);
    else c.update(pw);
    final = c.digest();
  }

  let out = magic + (salt || '') + '$';
  out += to64((final[0] << 16) | (final[6] << 8) | final[12], 4);
  out += to64((final[1] << 16) | (final[7] << 8) | final[13], 4);
  out += to64((final[2] << 16) | (final[8] << 8) | final[14], 4);
  out += to64((final[3] << 16) | (final[9] << 8) | final[15], 4);
  out += to64((final[4] << 16) | (final[10] << 8) | final[5], 4);
  out += to64(final[11], 2);
  return out;
}

module.exports = { md5crypt, randomSalt };
