// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Index for asynchronous affine type management
 * @author IronVelo
 * @version 0.3.0
 */

import * as queue from './queue';
import { default as BrowserAffine } from './browser';
import { default as SimpleAffine } from './simple';
import * as errors from './error';

export const browser = { Affine: BrowserAffine };
export const simple = { Affine: SimpleAffine };
export { errors, queue };
