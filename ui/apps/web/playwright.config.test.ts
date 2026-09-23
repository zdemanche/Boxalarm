import { expect, test } from 'vitest';
import config from './playwright.config';

test('the preview server the e2e run boots matches the baseURL it asserts against', () => {
  const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;

  expect(config.use?.baseURL).toBe(webServer?.url);
});

test('the e2e suite runs the accessibility-scanning chromium project', () => {
  expect(config.projects?.map((project) => project.name)).toContain('chromium');
});
