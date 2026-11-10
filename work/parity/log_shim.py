"""Plain-data wrapper around log_setup for the Deno parity tests (work/deno/log_test.ts): set up a file log the way a program does,
write one record, and release the file again so the Deno side can append to the same file."""
import logging

import log_setup


def write_line(state_dir, filename, name, level, message, *args):
    path = log_setup.setup('parity', level='DEBUG', state_dir=state_dir, filename=filename, stream=False)
    logging.getLogger(name).log(log_setup.parse_level(level), message, *args)
    log_setup.setup('parity', level='WARNING', state_dir=None, filename=None, stream=False)   # closes the file handler
    return str(path)
