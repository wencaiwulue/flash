#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif
#include <sys/select.h>
#include <sys/wait.h>
#include <sys/ioctl.h>

int main(int argc, char **argv) {
    int cols = 80, rows = 24;
    int argi = 1;
    if (argc > 2 && strcmp(argv[1], "--cols") == 0) { cols = atoi(argv[2]); argi = 3; }
    if (argc > argi + 2 && strcmp(argv[argi], "--rows") == 0) { rows = atoi(argv[argi+1]); argi += 2; }
    if (argi >= argc) { fprintf(stderr, "usage: ptyrun [--cols N --rows N] cmd [args...]\n"); return 2; }

    struct winsize ws = { .ws_col = cols, .ws_row = rows };
    int master;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) { perror("forkpty"); return 3; }
    if (pid == 0) {
        setenv("TERM", "xterm-256color", 1);
        execvp(argv[argi], &argv[argi]);
        perror("execvp");
        _exit(127);
    }

    int stdin_open = 1;
    char buf[65536];
    fd_set fds;
    for (;;) {
        FD_ZERO(&fds);
        if (stdin_open) FD_SET(0, &fds);
        FD_SET(master, &fds);
        if (select(master + 1, &fds, NULL, NULL, NULL) < 0) break;
        if (stdin_open && FD_ISSET(0, &fds)) {
            ssize_t n = read(0, buf, sizeof(buf));
            if (n <= 0) { stdin_open = 0; }
            else {
                ssize_t off = 0;
                while (off < n) {
                    ssize_t w = write(master, buf + off, n - off);
                    if (w <= 0) break;
                    off += w;
                }
            }
        }
        if (FD_ISSET(master, &fds)) {
            ssize_t n = read(master, buf, sizeof(buf));
            if (n <= 0) break;
            fwrite(buf, 1, n, stdout);
            fflush(stdout);
        }
    }
    int status;
    waitpid(pid, &status, 0);
    close(master);
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 1;
}
