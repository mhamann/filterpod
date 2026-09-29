/**
 * /privacy — the repo's PRIVACY.md, bundled at build time.
 *
 * One source of truth: the policy the site shows is the file in git, so the page and
 * the history that PRIVACY.md points to ("nothing can change quietly") never disagree.
 */

import { marked } from "marked";
import policy from "../../../PRIVACY.md";

export const PRIVACY_HTML = marked.parse(policy, { async: false, gfm: true });
