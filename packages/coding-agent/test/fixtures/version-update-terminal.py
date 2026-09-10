"""Run the source CLI in a real 100x30 PTY and relay test input/output."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


child, terminal = pty.fork()
if child == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])


def stop(_signal, _frame):
    raise SystemExit(1)


signal.signal(signal.SIGTERM, stop)
try:
    inputs = [terminal, 0]
    while True:
        readable, _, _ = select.select(inputs, [], [])
        for source in readable:
            try:
                data = os.read(source, 65536)
            except OSError as error:
                if source == terminal and error.errno == errno.EIO:
                    data = b""
                else:
                    raise
            if not data:
                if source == terminal:
                    _, status = os.waitpid(child, 0)
                    child = None
                    sys.exit(os.waitstatus_to_exitcode(status))
                inputs.remove(source)
            else:
                os.write(1 if source == terminal else terminal, data)
finally:
    os.close(terminal)
    if child is not None:
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(child, 0)
