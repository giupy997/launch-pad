/** Copy to the clipboard, saying whether it worked: the API rejects in
 *  webviews, without focus or without permission, and a wallet backup that
 *  only looked copied is a wallet lost. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
