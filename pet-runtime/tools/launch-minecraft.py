#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""launch-minecraft.py — 直接起 Minecraft（不走启动器 UI）（2026-11-14）

为什么不用 PCL/HMCL 的界面：她要做的是「自己开游戏自己玩」，UI 点几下既慢又脆
（弹公告/更新提示/多实例选择）。这里直接读版本 JSON 拼 java 命令，一步到位。

用法：
  python launch-minecraft.py --list                    # 列出可用实例
  python launch-minecraft.py --version 1.21.1 --dry    # 只打印命令
  python launch-minecraft.py --version 1.21.1 --width 1280 --height 720
  python launch-minecraft.py --version 1.21.1 --memory 3G --detach

要点：
  · libraries 的 rules 必须按 OS 过滤（不过滤会把 Linux natives 塞进 classpath）
  · natives 目录用 `--natives` 指，不给就找 `<verDir>/<verId>-natives`
  · 离线账号：username 随便给，uuid/accessToken 用 PCL 的零值形式（单人游戏够用）
  · 启动后立刻返回（detached），不等游戏退出
"""
import argparse
import json
import os
import subprocess
import sys

MC_ROOT = os.environ.get('MC_ROOT') or os.path.join(
    os.environ.get('APPDATA') or os.path.expanduser('~'), '.minecraft')
JAVA = os.environ.get('MC_JAVA') or os.path.join(
    os.path.expanduser('~'), 'AppData', 'Roaming', '.minecraft',
    'runtime', 'java-runtime-delta', 'bin', 'java.exe')


def versions():
    d = os.path.join(MC_ROOT, 'versions')
    if not os.path.isdir(d):
        return []
    return sorted(n for n in os.listdir(d)
                  if os.path.isfile(os.path.join(d, n, n + '.json')))


def os_allowed(lib):
    """按 rules 过滤（Windows x64）。没有 rules = 全平台可用。"""
    rules = lib.get('rules')
    if not rules:
        return True
    allowed = False
    for r in rules:
        action = r.get('action')
        osn = (r.get('os') or {}).get('name') or ''
        arch = (r.get('os') or {}).get('arch') or ''
        if action == 'allow':
            if not osn or osn == 'windows':
                if arch and arch != 'x86_64':
                    continue
                allowed = True
        elif action == 'disallow':
            if osn == 'windows':
                return False
    return allowed


def load_version_json(name):
    """读一个版本的 JSON（不合并）。"""
    p = os.path.join(MC_ROOT, 'versions', name, name + '.json')
    with open(p, encoding='utf-8-sig') as f:
        return json.load(f)


def resolve_version_json(name):
    """读版本 JSON，**递归合并 inheritsFrom**（2026-11-14 五十三轮）。

    为什么必须：Fabric/Forge/NeoForge 的 profile 只写**增量**（自己的 loader 库 + mainClass），
    父版本（vanilla 1.21.1）的 97 个库、assets、arguments 全在另一边。
    本脚本原来只读单文件 —— 拿 Fabric profile 直接启动会缺一堆 vanilla 库，必然起不来。
    合并规则（与官方 launcher 同口径）：
      · 标量：子版本有就覆盖
      · libraries：按 name 合并，同名以子版本为准（子版本可以覆盖父版本的同名库）
      · arguments.game / arguments.jvm：父在前、子在后（拼接）
      · minecraftArguments（老格式）：子版本有就整体覆盖
    """
    ver = load_version_json(name)
    seen = {name}
    while True:
        parent_name = ver.get('inheritsFrom')
        if not parent_name or parent_name in seen:
            break
        seen.add(parent_name)
        parent = load_version_json(parent_name)
        merged = dict(parent)
        for k in ('id', 'mainClass', 'assets', 'assetIndex', 'javaVersion', 'type',
                  'releaseTime', 'time', 'logging', 'downloads', 'complianceLevel',
                  'minimumLauncherVersion', 'jar'):
            if k in ver:
                merged[k] = ver[k]
        libs = {}
        for lib in parent.get('libraries') or []:
            libs[lib.get('name') or str(len(libs))] = lib
        for lib in ver.get('libraries') or []:
            libs[lib.get('name') or str(len(libs))] = lib
        merged['libraries'] = list(libs.values())
        if 'arguments' in parent or 'arguments' in ver:
            pa = parent.get('arguments') or {}
            ca = ver.get('arguments') or {}
            merged['arguments'] = {
                'game': list(pa.get('game') or []) + list(ca.get('game') or []),
                'jvm': list(pa.get('jvm') or []) + list(ca.get('jvm') or []),
            }
        if 'minecraftArguments' in ver:
            merged['minecraftArguments'] = ver['minecraftArguments']
        for k in ('inheritsFrom',):
            merged.pop(k, None)
        ver = merged
    return ver


def base_jar_version(name):
    """沿 inheritsFrom 找到**真正有 jar 的**那一层（Fabric/Forge profile 自己没有 jar）。

    实测坑（2026-11-14）：直接按 fabric-loader-xxx 版本目录找 jar/natives —— 那个目录里
    只有 JSON，jar 和 natives 都在父版本（1.21.1）目录里。找不到 natives 时 LWJGL 静默起不来，
    表现是「java 进程在、窗口永远不出现」，日志也不写。
    """
    seen = set()
    cur = name
    while cur and cur not in seen:
        seen.add(cur)
        if os.path.isfile(os.path.join(MC_ROOT, 'versions', cur, cur + '.jar')):
            return cur
        try:
            v = load_version_json(cur)
        except Exception:
            break
        cur = v.get('inheritsFrom')
    return name


def build_classpath(ver_json):
    libs = []
    lib_root = os.path.join(MC_ROOT, 'libraries')
    for lib in ver_json.get('libraries') or []:
        if not os_allowed(lib):
            continue
        path = ((lib.get('downloads') or {}).get('artifact') or {}).get('path')
        if not path:
            # 少数条目只给 name（group:artifact:version）→ 自己拼
            name = lib.get('name') or ''
            parts = name.split(':')
            if len(parts) < 3:
                continue
            group, artifact, version = parts[0], parts[1], parts[2]
            path = group.replace('.', '/') + '/' + artifact + '/' + version + '/' + artifact + '-' + version + '.jar'
        full = os.path.join(lib_root, path.replace('/', os.sep))
        if os.path.isfile(full):
            libs.append(full)
    return libs


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--version', default='')
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=720)
    ap.add_argument('--memory', default='3G')
    ap.add_argument('--username', default='user')
    ap.add_argument('--java', default=JAVA)
    ap.add_argument('--game-dir', default='', help='游戏目录（默认=版本目录）；装 Mod 时指到原版实例可复用同一个世界')
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--detach', action='store_true', default=True)
    args = ap.parse_args(argv)

    if args.list:
        for v in versions():
            print(v)
        return 0

    if not args.version:
        print('要 --version（可用：%s）' % ', '.join(versions()[:8]), file=sys.stderr)
        return 2
    ver_dir = os.path.join(MC_ROOT, 'versions', args.version)
    ver_json_path = os.path.join(ver_dir, args.version + '.json')
    if not os.path.isfile(ver_json_path):
        print('没有这个版本的 JSON：' + ver_json_path, file=sys.stderr)
        return 2
    # 合并 inheritsFrom：Fabric/Forge 的 profile 只有增量，父版本才有完整库表
    try:
        ver = resolve_version_json(args.version)
    except Exception as e:
        print('解析版本 JSON 失败：%s' % e, file=sys.stderr)
        return 2
    if not os.path.isfile(args.java):
        print('找不到 Java：' + args.java, file=sys.stderr)
        return 2

    # ⚠ 这里不能再读单文件：ver 必须是 resolve_version_json() 合并过 inheritsFrom 的结果，
    #   否则 Fabric/Forge profile 会缺父版本的库（97 个）→ 启动必失败。
    cp = build_classpath(ver)
    # jar 与 natives 都要沿 inheritsFrom 找真正有文件的那一层（Fabric profile 目录里只有 JSON）
    jar_ver = base_jar_version(args.version)
    jar_dir = os.path.join(MC_ROOT, 'versions', jar_ver)
    jar = os.path.join(jar_dir, jar_ver + '.jar')
    if os.path.isfile(jar):
        cp.append(jar)
    natives = os.path.join(jar_dir, jar_ver + '-natives')
    if not os.path.isdir(natives):
        natives = os.path.join(ver_dir, args.version + '-natives')

    zero = '00000FFFFFFFFFFFFFFFFFFFFFF1A0A3'
    cmd = [
        args.java,
        '-Xmx' + args.memory, '-Xms' + args.memory,
        '-Djava.library.path=' + natives,
        '-Djna.tmpdir=' + natives,
        '-Dorg.lwjgl.system.SharedLibraryExtractPath=' + natives,
        '-Dio.netty.native.workdir=' + natives,
        '-Dminecraft.launcher.brand=PCL', '-Dminecraft.launcher.version=408',
        '-Dstdout.encoding=utf-8', '-Dstderr.encoding=utf-8',
        '-Dlog4j2.formatMsgNoLookups=true',
        '-cp', os.pathsep.join(cp),
        ver.get('mainClass') or 'net.minecraft.client.main.Main',
        '--username', args.username,
        '--version', args.version,
        '--gameDir', (args.game_dir or ver_dir),
        '--assetsDir', os.path.join(MC_ROOT, 'assets'),
        '--assetIndex', str((ver.get('assetIndex') or {}).get('id') or '17'),
        '--uuid', zero, '--accessToken', zero,
        '--clientId', '${clientid}', '--xuid', '${auth_xuid}',
        '--userType', 'msa', '--versionType', 'PCL',
        '--width', str(args.width), '--height', str(args.height),
    ]

    if args.dry:
        print(' '.join('"%s"' % c if ' ' in c else c for c in cmd))
        return 0

    # detached：游戏活自己的，我们不等它（关掉这个脚本游戏也不退）
    creationflags = 0
    if os.name == 'nt':
        creationflags = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    p = subprocess.Popen(
        cmd,
        cwd=ver_dir,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )
    print(json.dumps({
        'ok': True, 'pid': p.pid, 'version': args.version,
        'window': '%dx%d' % (args.width, args.height),
        'classpath_jars': len(cp), 'java': args.java,
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
