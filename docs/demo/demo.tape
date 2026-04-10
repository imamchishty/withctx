# withctx demo — renders to docs/images/demo.gif
# Regenerate with: vhs docs/demo/demo.tape

Output docs/images/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 720
Set Theme "Dracula"
Set PlaybackSpeed 1.0
Set TypingSpeed 40ms
Set LineHeight 1.4
Set Padding 20
Set Margin 20

# Hidden setup: fresh scratch directory so the State 1 welcome shows
Hide
Type "rm -rf /tmp/withctx-demo && mkdir -p /tmp/withctx-demo && cd /tmp/withctx-demo"
Enter
Type "export PS1='$ '"
Enter
Type "clear"
Enter
Show

# Smart default — no args
Type "ctx"
Sleep 600ms
Enter
Sleep 4s

# Grouped help
Type "clear"
Enter
Sleep 300ms
Type "ctx help"
Sleep 400ms
Enter
Sleep 5s

# Doctor health check
Type "clear"
Enter
Sleep 300ms
Type "ctx doctor"
Sleep 400ms
Enter
Sleep 5s

# Closing frame
Type "clear"
Enter
Sleep 300ms
Type "# withctx — AI-compiled project wiki"
Sleep 800ms
Enter
Type "# 16 sources  -  136 tests  -  one command: ctx go"
Sleep 3s
