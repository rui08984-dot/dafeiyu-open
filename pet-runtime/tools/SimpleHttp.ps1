# SimpleHttp.ps1 —— TcpListener 版极简 HTTP 服务（2026-11-09 三十五轮）
#
# 为什么不用 HttpListener（这是踩过两次的真坑）：
#   ① HttpListener 注册到内核 http.sys，**端口的 owning process 是 PID 4 (System)**。
#      后果：kill-all-pet.ps1 按端口找进程时只能找到 PID 4 → 杀不掉 → 服务假活、
#      端口残留、新的服务起不来（报「拒绝访问」）。
#   ② http.sys 的 URL 注册有残留期，进程死了端口可能还被挂着。
#   ③ 需要 URL ACL（管理员 netsh http add urlacl）才能绑非 localhost 前缀。
#
# TcpListener 的好处：端口直接归本进程，kill 得掉、退出就释放。
#
# 能力边界（够我们用，不要拿去做通用服务器）：
#   · 只支持 HTTP/1.1 POST/GET + Content-Length 定长 body
#   · 不支持 chunked（Node 的 http.request 默认发 Content-Length，没这个问题）
#   · 不支持 keep-alive：每个响应都带 `Connection: close` 并关闭连接
#   · 只绑 127.0.0.1（安全：外部访问不到）
#
# 用法：
#   . (Join-Path $PSScriptRoot 'SimpleHttp.ps1')
#   $srv = New-SimpleHttp -Port 8106
#   Write-Output "[svc] listening 127.0.0.1:8106"
#   while ($true) {
#       $req = Receive-SimpleRequest -Server $srv     # 阻塞，返回 $null 表示这条连接有问题（继续循环）
#       if (-not $req) { continue }
#       $out = '{"ok":true}'                           # 你的业务逻辑
#       Send-SimpleResponse -Context $req -Body $out
#   }

function New-SimpleHttp {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [string]$BindAddress = '127.0.0.1'
    )
    $listener = New-Object System.Net.Sockets.TcpListener(
        [System.Net.IPAddress]::Parse($BindAddress), $Port)
    # ExclusiveAddressUse = true：防止别的进程用 SO_REUSEADDR 抢同一个端口
    # （Windows 上不加这个，两个进程能同时绑同一端口，出问题极难排查）
    $listener.ExclusiveAddressUse = $true
    $listener.Start(64)   # backlog 64
    return $listener
}

function Receive-SimpleRequest {
    param([Parameter(Mandatory = $true)]$Server)

    $client = $null
    try {
        $client = $Server.AcceptTcpClient()
        $client.ReceiveTimeout = 10000      # 10 秒收不到数据就放弃这条连接
        $stream = $client.GetStream()

        # ── 读请求头（一直读到 \r\n\r\n）──────────────────────────────
        $headerBuf = New-Object System.Collections.Generic.List[byte]
        $one = New-Object byte[] 1
        $state = 0   # 0=还没遇到 \r, 1=遇到 \r, 2=遇到 \r\n, 3=遇到 \r\n\r（下一个 \n 收尾）
        $guard = 0
        while ($guard -lt 65536) {
            $guard += 1
            $n = $stream.Read($one, 0, 1)
            if ($n -le 0) { break }
            $b = $one[0]
            $headerBuf.Add($b)
            switch ($state) {
                0 { if ($b -eq 13) { $state = 1 } }
                1 { if ($b -eq 10) { $state = 2 } else { $state = 0 } }
                2 { if ($b -eq 13) { $state = 3 } else { $state = 0 } }
                3 {
                    if ($b -eq 10) { $guard = 999999 }   # 头部结束
                    else { $state = 0 }
                }
            }
        }
        if ($headerBuf.Count -eq 0) {
            try { $client.Close() } catch { }
            return $null
        }

        $headerText = [System.Text.Encoding]::UTF8.GetString($headerBuf.ToArray())
        $lines = $headerText -split "`r`n"
        if ($lines.Count -lt 1 -or [string]::IsNullOrWhiteSpace($lines[0])) {
            try { $client.Close() } catch { }
            return $null
        }

        # ── 解析请求行：POST /path HTTP/1.1 ──────────────────────────
        $parts = $lines[0] -split ' '
        $method = if ($parts.Count -ge 1) { $parts[0].ToUpper() } else { 'GET' }
        $rawTarget = if ($parts.Count -ge 2) { $parts[1] } else { '/' }
        # 去掉 query string（我们的接口不用 query）
        $path = ($rawTarget -split '\?')[0]

        # ── 解析头 ───────────────────────────────────────────────────
        $headers = @{}
        for ($i = 1; $i -lt $lines.Count; $i += 1) {
            $ln = $lines[$i]
            if ([string]::IsNullOrWhiteSpace($ln)) { continue }
            $idx = $ln.IndexOf(':')
            if ($idx -gt 0) {
                $k = $ln.Substring(0, $idx).Trim().ToLower()
                $v = $ln.Substring($idx + 1).Trim()
                $headers[$k] = $v
            }
        }

        # ── 读 body（Content-Length 定长）────────────────────────────
        $body = ''
        $clen = 0
        if ($headers.ContainsKey('content-length')) {
            [void][int]::TryParse($headers['content-length'], [ref]$clen)
        }
        if ($clen -gt 0) {
            if ($clen -gt 8 * 1024 * 1024) {
                # 8MB 上限：这些服务都是本地小 payload，限制防内存炸弹
                try { $client.Close() } catch { }
                return $null
            }
            $buf = New-Object byte[] $clen
            $read = 0
            while ($read -lt $clen) {
                $n = $stream.Read($buf, $read, $clen - $read)
                if ($n -le 0) { break }
                $read += $n
            }
            if ($read -gt 0) {
                $body = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
            }
        }

        return @{
            Method  = $method
            Path    = $path
            Headers = $headers
            Body    = $body
            Client  = $client
            Stream  = $stream
        }
    }
    catch {
        if ($client) { try { $client.Close() } catch { } }
        return $null
    }
}

function Send-SimpleResponse {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [string]$Body = '',
        [int]$StatusCode = 200,
        [string]$ContentType = 'application/json; charset=utf-8'
    )
    try {
        $statusText = switch ($StatusCode) {
            200 { 'OK' }
            400 { 'Bad Request' }
            404 { 'Not Found' }
            413 { 'Payload Too Large' }
            500 { 'Internal Server Error' }
            default { 'OK' }
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
        $head = "HTTP/1.1 $StatusCode $statusText`r`n" +
                "Content-Type: $ContentType`r`n" +
                "Content-Length: $($bytes.Length)`r`n" +
                "Connection: close`r`n" +
                "Cache-Control: no-store`r`n" +
                "`r`n"
        $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
        $Context.Stream.Write($headBytes, 0, $headBytes.Length)
        $Context.Stream.Write($bytes, 0, $bytes.Length)
        $Context.Stream.Flush()
    }
    catch {
        # 客户端已经断开是常态（curl --max-time / Node 超时），不该影响服务
    }
    finally {
        try { $Context.Client.Close() } catch { }
    }
}

function Close-SimpleHttp {
    param([Parameter(Mandatory = $true)]$Server)
    try { $Server.Stop() } catch { }
}
