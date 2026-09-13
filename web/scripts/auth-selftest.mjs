import assert from 'node:assert/strict';
import { friendlyAuthError, usernameToEmail, validateUsername } from '../src/lib/auth.js';

assert.equal(usernameToEmail('  Boris Van Der Heyden  '), 'boris_van_der_heyden@players.hs-battleships.invalid');
assert.equal(usernameToEmail('MiXeD---Name'), 'mixed---name@players.hs-battleships.invalid');
assert.equal(usernameToEmail('Rune.Scape_Name'), 'rune.scape_name@players.hs-battleships.invalid');

assert.equal(validateUsername('HS Player'), null);
assert.equal(validateUsername(' a '), 'Username must be at least 2 characters.');
assert.equal(validateUsername('   '), 'Username must be at least 2 characters.');
assert.equal(validateUsername('x'.repeat(33)), 'Username must be 32 characters or fewer.');
assert.equal(validateUsername('name@example'), 'Use only letters, numbers, spaces, dots, underscores or hyphens.');

assert.equal(friendlyAuthError('Invalid login credentials'), 'Wrong username or password.');
assert.equal(friendlyAuthError('User already registered'), 'That username is taken.');
assert.equal(friendlyAuthError('Password should be at least 8 characters'), 'Password must be at least 8 characters.');
assert.equal(friendlyAuthError('Unexpected outage'), 'Unexpected outage');

console.log('Authentication helper self-test passed.');
