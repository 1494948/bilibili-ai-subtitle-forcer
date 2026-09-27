#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标（纯标准库，无需 Pillow）。

设计：B站粉圆角方块 + 白色 "AI" 点阵字 + 底部字幕横条。
用法：python tools/make-icons.py
输出：icons/icon16.png icon32.png icon48.png icon128.png
"""
import os
import struct
import zlib

# B站粉
BG = (0xFB, 0x72, 0x99, 0xFF)
BG_DARK = (0xD9, 0x4D, 0x74, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF, 0xFF)
CLEAR = (0x00, 0x00, 0x00, 0x00)

# 5x7 点阵（每一行一个字符串，'#' 为实心）
GLYPHS = {
    "A": [
        "..#..",
        ".#.#.",
        "#...#",
        "#...#",
        "#####",
        "#...#",
        "#...#",
    ],
    "I": [
        "#####",
        "..#..",
        "..#..",
        "..#..",
        "..#..",
        "..#..",
        "#####",
    ],
    "字幕条" : [],
}

TEXT = "AI"


def blank(size):
    return [[CLEAR for _ in range(size)] for _ in range(size)]


def blend(dst, src):
    """src 覆盖到 dst 上（src 需已做 alpha 混合）。"""
    a = src[3] / 255.0
    inv = 1.0 - a
    return (
        int(src[0] * a + dst[0] * inv),
        int(src[1] * a + dst[1] * inv),
        int(src[2] * a + dst[2] * inv),
        max(dst[3], src[3]),
    )


def put(px, size, x, y, color):
    if 0 <= x < size and 0 <= y < size:
        if color[3] == 255:
            px[y][x] = color
        else:
            px[y][x] = blend(px[y][x], color)


def rounded_rect(px, size, x0, y0, x1, y1, r, color):
    """圆角矩形，用距离场做抗锯齿边缘。"""
    for y in range(size):
        if y < y0 or y > y1:
            continue
        for x in range(size):
            if x < x0 or x > x1:
                continue
            # 到圆角中心的距离
            dx = 0
            if x < x0 + r:
                dx = (x0 + r) - x
            elif x > x1 - r:
                dx = x - (x1 - r)
            dy = 0
            if y < y0 + r:
                dy = (y0 + r) - y
            elif y > y1 - r:
                dy = y - (y1 - r)
            if dx == 0 and dy == 0:
                alpha = 255
            else:
                dist = (dx * dx + dy * dy) ** 0.5
                if dist <= r - 1:
                    alpha = 255
                elif dist >= r + 0.5:
                    alpha = 0
                else:
                    # 注意：r+0.5-dist 可达 1.5，直接乘 255 会溢出成 382
                    alpha = min(255, int(255 * (r + 0.5 - dist)))
            if alpha <= 0:
                continue
            c = (color[0], color[1], color[2],
                 min(255, int(color[3] * alpha / 255)))
            px[y][x] = blend(px[y][x], c)


def draw_text(px, size, text, scale, origin_x, origin_y, color):
    """按点阵逐像素写字，scale 为每个点阵像素占的方块边长。"""
    cx = origin_x
    for ch in text:
        g = GLYPHS.get(ch)
        if not g:
            continue
        for gy, row in enumerate(g):
            for gx, cell in enumerate(row):
                if cell != "#":
                    continue
                for oy in range(scale):
                    for ox in range(scale):
                        put(px, size, cx + gx * scale + ox,
                            origin_y + gy * scale + oy, color)
        cx += (len(g[0]) + 1) * scale


def render(size):
    px = blank(size)

    # 1) 圆角底：整体略小于画布，留出透明边距
    pad = max(1, round(size * 0.03))
    radius = max(2, round(size * 0.22))
    rounded_rect(px, size, pad, pad, size - 1 - pad, size - 1 - pad, radius, BG)

    # 2) 顶部高光带（让图标有层次）
    hi = (255, 255, 255, 26)
    rounded_rect(px, size, pad, pad, size - 1 - pad,
                 pad + max(1, round(size * 0.30)), radius, hi)

    # 3) "AI" 文字，居中偏上
    scale = max(1, round(size / 20.0))
    text_w = (5 * 2 + 1) * scale          # A 和 I 各 5 列 + 1 列间距
    text_h = 7 * scale
    ox = (size - text_w) // 2
    oy = int(size * 0.46) - text_h // 2
    draw_text(px, size, TEXT, scale, ox, oy, WHITE)

    # 4) 底部字幕条：两条圆角横杠，代表正在显示的字幕
    bar_h = max(1, round(size * 0.055))
    bar_w1 = round(size * 0.50)
    bar_w2 = round(size * 0.32)
    bx = (size - bar_w1) // 2
    by = int(size * 0.80)
    rounded_rect(px, size, bx, by, bx + bar_w1 - 1, by + bar_h - 1,
                 max(1, bar_h // 2), WHITE)
    bx2 = (size - bar_w2) // 2
    by2 = by + bar_h + max(1, round(size * 0.045))
    rounded_rect(px, size, bx2, by2, bx2 + bar_w2 - 1, by2 + bar_h - 1,
                 max(1, bar_h // 2), (255, 255, 255, 170))

    return px


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)                       # filter type 0
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, os.pardir, "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        px = render(size)
        p = os.path.abspath(os.path.join(out, "icon%d.png" % size))
        n = write_png(p, px)
        print("icon%d.png  %d bytes" % (size, n))


if __name__ == "__main__":
    main()
