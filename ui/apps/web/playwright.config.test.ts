import { expect, test, vi } from 'vitest';
import config from './playwright.config';

test('the preview server the e2e run boots matches the baseURL it asserts against', () => {
  const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;

  expect(config.use?.baseURL).toBe(webServer?.url);
});

test('the e2e suite runs the accessibility-scanning chromium project', () => {
  expect(config.projects?.map((project) => project.name)).toContain('chromium');
});

test('a committed test.only fails the CI e2e run instead of silently narrowing it', async () => {
  vi.stubEnv('CI', 'true');
  vi.resetModules();
  const { default: ciConfig } = await import('./playwright.config');
  vi.unstubAllEnvs();

  expect(ciConfig.forbidOnly).toBe(true);
});
