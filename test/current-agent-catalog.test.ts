import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenClawCliEnv, resolveOpenClawWorkspaceRootPath } from "../src/runtime/current-agent-catalog";

test("resolveOpenClawWorkspaceRootPath defaults under OPENCLAW_HOME and honors explicit override", () => {
  const originalHome = process.env.OPENCLAW_HOME;
  const originalWorkspaceRoot = process.env.OPENCLAW_WORKSPACE_ROOT;

  try {
    process.env.OPENCLAW_HOME = "/tmp/openclaw-home";
    delete process.env.OPENCLAW_WORKSPACE_ROOT;
    assert.equal(resolveOpenClawWorkspaceRootPath(), "/tmp/openclaw-home/workspace");

    process.env.OPENCLAW_WORKSPACE_ROOT = "/tmp/custom-workspace";
    assert.equal(resolveOpenClawWorkspaceRootPath(), "/tmp/custom-workspace");
  } finally {
    if (originalHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalHome;
    if (originalWorkspaceRoot === undefined) delete process.env.OPENCLAW_WORKSPACE_ROOT;
    else process.env.OPENCLAW_WORKSPACE_ROOT = originalWorkspaceRoot;
  }
});

test("buildOpenClawCliEnv strips npm pollution and OPENCLAW overrides but keeps provider secrets", () => {
  const original = {
    npm_config_user_agent: process.env.npm_config_user_agent,
    INIT_CWD: process.env.INIT_CWD,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_WORKSPACE_ROOT: process.env.OPENCLAW_WORKSPACE_ROOT,
    JINA_API_KEY: process.env.JINA_API_KEY,
    PATH: process.env.PATH,
  };

  try {
    process.env.npm_config_user_agent = "npm-test-agent";
    process.env.INIT_CWD = "/tmp/init-cwd";
    process.env.OPENCLAW_HOME = "/tmp/override-home";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/override-config.json";
    process.env.OPENCLAW_WORKSPACE_ROOT = "/tmp/override-workspace";
    process.env.JINA_API_KEY = "jina_test_key";

    const env = buildOpenClawCliEnv();

    assert.equal(env.npm_config_user_agent, undefined);
    assert.equal(env.INIT_CWD, undefined);
    assert.equal(env.OPENCLAW_HOME, undefined);
    assert.equal(env.OPENCLAW_CONFIG_PATH, undefined);
    assert.equal(env.OPENCLAW_WORKSPACE_ROOT, undefined);
    assert.equal(env.JINA_API_KEY, "jina_test_key");
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
  }
});
