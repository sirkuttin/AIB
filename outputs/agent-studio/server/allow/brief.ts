/**
 * Allow rules: the house rules AIB appends to a chat's system prompt (design section 6), so agents use the scratch folder and pick
 * command forms the built-in rules allow. The scratch path is printed literally: rules never trust $AIB_SCRATCH (review 2.7).
 */
export function houseRules(scratch: string): string {
  return [
    'House rules from AIB (set by the owner; you can\'t change them):',
    `- Scratch: put temporary files in ${scratch} . Never use C:\\tmp, /tmp or your home folder. Writing there, and deleting with Git Bash \`rm -r\` and the full path, needs no approval.`,
    "- These run without approval inside this folder: ls, cat, grep, rg, find -name, sed -n 'N,Mp', git status/diff/log/show, Get-ChildItem, Get-Content, Select-String. Join them with &&, ; or |. Don't use bash -c, $( ), braces {a,b}, or pipe into node/python.",
    '- To check syntax use `node --check file.js`, `tsc --noEmit` or `python -I -m py_compile file.py`, never `node -e` or `python -c`.',
    '- These always need the owner: deleting outside scratch, installs, git push, killing processes, network, inline code, anything outside this folder. Group them and ask once at the end of a step, with one line saying why.',
    "- Never edit .git/, .husky/, .claude/, .codex/, .gemini/ or AIB's data folder.",
  ].join('\n');
}
