import readline from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Terminal prompt helper supporting both standard line input and hidden secret input
 * (passwords / PINs) without breaking Korean IME or piped test streams.
 */
export class CliPrompter {
  /**
   * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [io]
   */
  constructor(io = {}) {
    this.input = io.input ?? process.stdin;
    this.output = io.output ?? process.stdout;
    this.isTTY = Boolean(this.input.isTTY && this.output.isTTY);
    this.muted = false;
    this._closed = false;
    this._lineQueue = [];
    this._pendingResolve = null;

    const self = this;
    const mutableOutput = new Writable({
      write(chunk, encoding, callback) {
        if (!self.muted) {
          self.output.write(chunk, encoding, callback);
        } else {
          callback();
        }
      },
    });

    this.rl = readline.createInterface({
      input: this.input,
      output: mutableOutput,
      terminal: this.isTTY,
    });

    this.rl.on('line', (line) => {
      if (this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        resolve(line);
      } else {
        this._lineQueue.push(line);
      }
    });

    this.rl.on('close', () => {
      this._closed = true;
      if (this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        resolve(null);
      }
    });
  }

  #nextLine() {
    if (this._lineQueue.length > 0) {
      return Promise.resolve(this._lineQueue.shift());
    }
    if (this._closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
    });
  }

  /**
   * Prompt for standard visible text input.
   * @param {string} label
   * @param {{ defaultValue?: string }} [options]
   * @returns {Promise<string>}
   */
  async ask(label, options = {}) {
    const suffix = options.defaultValue ? ` [${options.defaultValue}]` : '';
    this.muted = false;
    this.output.write(`${label}${suffix}: `);
    const answer = await this.#nextLine();
    if (answer === null) return options.defaultValue ?? '';
    const trimmed = answer.trim();
    return trimmed || (options.defaultValue ?? '');
  }

  /**
   * Prompt for hidden input (password or PIN). Displays `*` per character on TTY.
   * @param {string} label
   * @returns {Promise<string>}
   */
  async askSecret(label) {
    this.output.write(`${label}: `);
    this.muted = true;
    const onKeypress = (_str, key) => {
      if (!this.muted || !this.isTTY) return;
      if (key?.name === 'return' || key?.name === 'enter') return;
      const mask = '*'.repeat(this.rl.line.length);
      this.output.write(`\r${label}: ${mask}\x1b[K`);
    };
    if (this.isTTY) {
      this.input.on('keypress', onKeypress);
    }
    try {
      const answer = await this.#nextLine();
      if (this.isTTY) {
        this.output.write('\n');
      }
      return (answer ?? '').trim();
    } finally {
      if (this.isTTY) {
        this.input.off('keypress', onKeypress);
      }
      this.muted = false;
    }
  }

  /**
   * Ask a Yes/No confirmation question.
   * @param {string} label
   * @param {boolean} [defaultYes=true]
   * @returns {Promise<boolean>}
   */
  async confirm(label, defaultYes = true) {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    this.muted = false;
    this.output.write(`${label} (${hint}): `);
    const answer = await this.#nextLine();
    if (answer === null || !answer.trim()) return defaultYes;
    const normalized = answer.trim().toLowerCase();
    if (['y', 'yes', '예', '네', '1'].includes(normalized)) return true;
    if (['n', 'no', '아니오', '아니요', '0'].includes(normalized)) return false;
    return defaultYes;
  }

  close() {
    if (!this._closed) {
      this.rl.close();
    }
  }
}
