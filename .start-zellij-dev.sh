#!/usr/bin/env zsh
exec zellij --session 'contribs' --layout '/tmp/zellij-contribs.layout'   || exec zellij attach 'contribs'
