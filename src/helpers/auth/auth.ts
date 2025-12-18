/**
 * Auth helper.
 * @module helpers/auth/auth
 */

import type { Request, User } from '../../types';

import { Knex } from 'knex';
import { filter, includes, isString, isUndefined } from 'lodash';
import jwt from 'jsonwebtoken';

const { config } = require(`${process.cwd()}/config`);

/**
 * Check required permission.
 * @method hasPermission
 * @param {string[]} permissions Permissions of the current user.
 * @param {string} permission Permission to check.
 * @returns {boolean} True if you have permission.
 */
export function hasPermission(
  permissions: string[],
  permission: string,
): boolean {
  return isUndefined(permission) || includes(permissions, permission);
}

/**
 * Get user based on token.
 * @method getUser
 * @param {Object} req Request object.
 * @returns {string} User id.
 */
export function getUserId(req: Request): string | undefined {
  // Check if auth token
  if (!req.token) {
    return 'anonymous';
  } else {
    let decoded;
    try {
      decoded = jwt.verify(req.token, config.secret);
    } catch (err) {
      return 'anonymous';
    }

    // Return user id
    return isString(decoded.sub) ? decoded.sub : undefined;
  }
}

/**
 * Add jwt token to user
 * @method addToken
 * @param {string} token Token to be added.
 * @param {Request} req Request object.
 */
export async function addToken(
  token: string,
  req: Request,
  trx: Knex.Transaction,
): Promise<undefined> {
  // Get tokens
  let tokens = req.user.tokens || [];

  // Remove expired tokens
  tokens = filter(tokens, (token) => {
    try {
      jwt.verify(token, config.secret);
      return true;
    } catch (e) {
      return false;
    }
  });

  // Add new token
  tokens.push(token);

  // Store tokens
  await req.user.update({ tokens }, trx);
}

/**
 * Remove jwt token from user
 * @method removeToken
 * @param {string} token Token to be removed.
 * @param {User} user User object.
 */
export async function removeToken(
  token: string,
  user: User,
  trx: Knex.Transaction,
): Promise<undefined> {
  // Get tokens
  let tokens = user.tokens || [];

  // Remove expired tokens
  tokens = filter(
    tokens,
    (tokenFromArray: string | undefined) => tokenFromArray !== token,
  );

  // Store tokens
  await user.update({ tokens }, trx);
}
