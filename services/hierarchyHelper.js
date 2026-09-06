const mongoose = require('mongoose');
const User = require('../models/User');

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Find a user by username (case-insensitive) or ObjectId.
 * Replaces the old findUserFromReq() that did up to 4 sequential DB queries.
 * This does at most 2 queries (1 regex + 1 ObjectId fallback).
 *
 * @param {string|ObjectId} key - Username string or ObjectId
 * @returns {Promise<Object|null>} User document (lean) or null
 */
async function findUserByKey(key) {
  if (!key) return null;
  const keyStr = key.toString().trim();
  if (!keyStr) return null;

  // Single case-insensitive regex query covers exact, lowercase, and case-variant lookups
  const safeStr = escapeRegex(keyStr);
  let user = await User.findOne({
    username: { $regex: new RegExp(`^${safeStr}$`, 'i') }
  }).lean();

  // Fallback: try by ObjectId if it looks like one
  if (!user && mongoose.Types.ObjectId.isValid(keyStr)) {
    user = await User.findById(keyStr).lean();
  }

  return user;
}

/**
 * Get all descendants of a parent using batch BFS.
 * Instead of recursive N+1 queries (one per child), this does O(depth) queries.
 * Typical hierarchy is 4 levels deep, so this does ~4 queries max regardless of user count.
 *
 * @param {ObjectId} parentId - The parent user's _id
 * @param {string} [selectFields] - Fields to select (default: '_id username role')
 * @returns {Promise<Array>} Array of descendant user documents (lean)
 */
async function getAllDescendants(parentId, selectFields = '_id username role') {
  const all = [];
  let currentIds = [parentId];

  while (currentIds.length > 0) {
    const children = await User.find({ parentId: { $in: currentIds } })
      .select(selectFields)
      .lean();

    if (children.length === 0) break;
    all.push(...children);
    currentIds = children.map(c => c._id);
  }

  return all;
}

/**
 * Get all descendant usernames (including the parent's own username).
 * Convenience wrapper for the common pattern of building allowedUsernames arrays.
 *
 * @param {Object} user - The user document (must have _id and username)
 * @returns {Promise<string[]>} Array of all usernames in the user's tree (including self)
 */
async function getAllDescendantUsernames(user) {
  if (user.role === 'superadmin') {
    const allUsers = await User.find({}).select('username').lean();
    return allUsers.map(u => u.username);
  }

  const descendants = await getAllDescendants(user._id, '_id username');
  return [user.username, ...descendants.map(d => d.username)];
}

/**
 * Build an ancestor chain from a user up to the top-level superadmin.
 * Uses batch fetching to minimize queries.
 *
 * @param {Object} user - The starting user document
 * @param {Object} [userMap] - Optional pre-built userMap to avoid extra queries
 * @returns {Promise<Array>} Array of ancestors from immediate parent to superadmin
 */
async function getAncestorChain(user, userMap = null) {
  const chain = [];
  let current = user;

  while (current && current.parentId) {
    let parent;
    if (userMap && userMap[current.parentId.toString()]) {
      parent = userMap[current.parentId.toString()];
    } else {
      parent = await User.findById(current.parentId).lean();
    }
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }

  return chain;
}

module.exports = {
  findUserByKey,
  getAllDescendants,
  getAllDescendantUsernames,
  getAncestorChain,
  escapeRegex
};
