SPECS['chats-views'] = ('tile', ['chats-full-view', 'chats-chat-view', 'chats-prompts-view'], (300, 50, 1650, 1125))
del SPECS['worktrees-changes-merge']
SPECS['06-worktree-changes-merge'] = ('worktrees-changes-merge-open', None)
SPECS['worktrees-merge-requested'] = ('worktrees-merge-requested', None)
SPECS['artifacts-menu-archive-delete'] = ('artifacts-menu-archive-delete', None)
SPECS['private-git-exclude'] = ('private-git-exclude', None)
SPECS['chats-subagent-card'] = ('chats-subagent-top', None)
for n in ['phone-cards', 'phone-approval', 'phone-new-chat']:
    SPECS[n] = (n, None)
for n in ['setup-00-switch-off', 'setup-01-switch-on', 'setup-02-tailscale-signed-in', 'setup-03-https', 'setup-04-shared', 'setup-05-add-phone-qr', 'setup-06-approve', 'setup-07-phones-list']:
    SPECS[n] = (n, None)
