export async function findGeminiTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tabs || tabs.length === 0) {
    return null;
  }

  // 1. Prefer currently active Gemini tab
  const activeTab = tabs.find((t) => t.active);
  if (activeTab) {
    return activeTab;
  }

  // 2. Prefer most recently active tab (if lastAccessed timestamp is present)
  const sortedByRecent = [...tabs].sort((a, b) => {
    const timeA = a.lastAccessed ?? 0;
    const timeB = b.lastAccessed ?? 0;
    return timeB - timeA;
  });

  if (sortedByRecent[0] && (sortedByRecent[0].lastAccessed ?? 0) > 0) {
    return sortedByRecent[0];
  }

  // 3. Fall back to the first valid Gemini tab
  return tabs[0] ?? null;
}
