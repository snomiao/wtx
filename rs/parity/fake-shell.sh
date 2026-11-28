#!/bin/sh
# A shell for the parity cases that attach by working directory: wtx starts
# $SHELL there, and a real shell's prompt depends on the machine (its rc
# files, its version). The cases copy this file to <ROOT>/fake-shell and set
# SHELL to it. It says where it runs, then answers each line it reads:
#
#   osc7 <path>   prints the OSC 7 sequence a shell prints for a directory
#                 (ended by BEL)
#   osc7st <path> the same, ended by ESC \
#   size          prints the terminal's size (stty size: rows and columns)
#   exit          ends
#   anything else is printed back as `got [<line>]`
printf 'fake shell in %s\r\n' "$(pwd)"
while IFS= read -r line; do
  case $line in
    exit) exit 0 ;;
    "osc7 "*) printf '\033]7;file://parity-host%s\007' "${line#osc7 }" ;;
    "osc7st "*) printf '\033]7;file://parity-host%s\033\\' "${line#osc7st }" ;;
    size) printf 'size %s\r\n' "$(stty size)" ;;
    *) printf 'got [%s]\r\n' "$line" ;;
  esac
done
