package com.dafeiyu.state;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.Box;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * 只读状态导出（2026-11-14 五十三轮 · 多通道框架的「进程内观测」通道）。
 *
 * 它只做一件事：每 2 tick（约 10Hz）把玩家/实体的状态拼成一行 JSON，
 * 通过 TCP 发给 127.0.0.1:8123（桌宠那边的 mod-provider.js 在收）。
 *
 * **只读**：不读内存、不改游戏状态、不发按键、不联网（只连本机回环）。
 * 断线不阻塞游戏：采样丢进队列，独立线程发；队列满了丢最旧的（宁可丢数据，不能拖慢游戏）。
 */
public class StateExporter implements ClientModInitializer {

    private static final String HOST = "127.0.0.1";
    private static final int PORT = 8123;
    private static final int QUEUE_MAX = 64;
    /** 采多少人附近的实体（格） */
    private static final double ENTITY_RADIUS = 24.0;

    private static final LinkedBlockingQueue<String> QUEUE = new LinkedBlockingQueue<>(QUEUE_MAX);
    private static volatile boolean started = false;
    private static int tickCounter = 0;

    @Override
    public void onInitializeClient() {
        startSenderOnce();
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            try {
                tickCounter++;
                if ((tickCounter & 1) != 0) return;              // 每 2 tick 采样一次
                if (client.player == null || client.world == null) return;
                String line = sample(client);
                if (line != null) offer(line);
            } catch (Throwable t) {
                // 绝不能让导出把游戏搞崩：异常吞掉（游戏里没有日志面板，静默是唯一选择）
            }
        });
    }

    private static void offer(String line) {
        if (!QUEUE.offer(line)) {          // 队列满：丢最旧的，再塞新的
            QUEUE.poll();
            QUEUE.offer(line);
        }
    }

    /** 采样：返回一行 JSON（手拼，省掉 Gson 依赖与反射开销） */
    private static String sample(MinecraftClient client) {
        ClientPlayerEntity p = client.player;
        double x = p.getX(), y = p.getY(), z = p.getZ();
        float yaw = p.getYaw(), pitch = p.getPitch();

        StringBuilder sb = new StringBuilder(512);
        sb.append('{');
        sb.append("\"t\":").append(System.currentTimeMillis());
        sb.append(",\"hp\":").append(round1(p.getHealth()));
        sb.append(",\"maxHp\":").append(round1(p.getMaxHealth()));
        sb.append(",\"food\":").append(p.getHungerManager().getFoodLevel());
        sb.append(",\"x\":").append(round2(x)).append(",\"y\":").append(round2(y)).append(",\"z\":").append(round2(z));
        sb.append(",\"yaw\":").append(round1(yaw)).append(",\"pitch\":").append(round1(pitch));
        try {
            sb.append(",\"dim\":\"").append(p.getWorld().getRegistryKey().getValue()).append('"');
        } catch (Throwable t) { /* 维度读不到就不给 */ }

        // ── 附近实体（只要类型/距离/准星偏差）──
        try {
            Box box = new Box(x - ENTITY_RADIUS, y - ENTITY_RADIUS, z - ENTITY_RADIUS,
                              x + ENTITY_RADIUS, y + ENTITY_RADIUS, z + ENTITY_RADIUS);
            List<Entity> near = new ArrayList<>();
            for (Entity e : client.world.getOtherEntities(p, box)) {
                if (e instanceof LivingEntity && e.isAlive()) near.add(e);
            }
            near.sort(Comparator.comparingDouble(e -> e.squaredDistanceTo(p)));
            sb.append(",\"entities\":[");
            int n = 0;
            for (Entity e : near) {
                if (n >= 8) break;
                if (n > 0) sb.append(',');
                String id;
                try { id = Registries.ENTITY_TYPE.getId(e.getType()).toString(); } catch (Throwable t) { id = "unknown"; }
                double dx = e.getX() - x, dy = e.getY() - y, dz = e.getZ() - z;
                double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                // 准星偏差（度）：目标方位角 - 玩家朝向，归一到 [-180,180]
                double targetYaw = Math.toDegrees(Math.atan2(-dx, dz));
                double yawDelta = normalizeDeg(targetYaw - yaw);
                double horiz = Math.max(0.01, Math.sqrt(dx * dx + dz * dz));
                double targetPitch = -Math.toDegrees(Math.atan2(dy, horiz));
                double pitchDelta = normalizeDeg(targetPitch - pitch);
                sb.append("{\"type\":\"").append(id).append('"')
                  .append(",\"dist\":").append(round2(dist))
                  .append(",\"yawDelta\":").append(round1(yawDelta))
                  .append(",\"pitchDelta\":").append(round1(pitchDelta))
                  .append('}');
                n++;
            }
            sb.append(']');
        } catch (Throwable t) { /* 实体段失败不影响血量/坐标 */ }

        // ── 背包（只给物品 id + 数量，不带 NBT）──
        try {
            sb.append(",\"inventory\":[");
            int n = 0;
            var main = p.getInventory().main;   // DefaultedList<ItemStack>
            for (int i = 0; i < main.size(); i++) {
                ItemStack st = main.get(i);
                if (st == null || st.isEmpty()) continue;
                if (n > 0) sb.append(',');
                String id;
                try { id = Registries.ITEM.getId(st.getItem()).toString(); } catch (Throwable t) { id = "unknown"; }
                sb.append("{\"slot\":").append(i).append(",\"id\":\"").append(id)
                  .append("\",\"count\":").append(st.getCount()).append('}');
                if (++n >= 36) break;
            }
            sb.append(']');
        } catch (Throwable t) { /* 背包段失败不影响其它 */ }

        sb.append('}');
        return sb.toString();
    }

    private static double normalizeDeg(double d) {
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        return d;
    }

    private static double round1(double v) { return Math.round(v * 10.0) / 10.0; }

    private static double round2(double v) { return Math.round(v * 100.0) / 100.0; }

    /** 独立的发送线程：断线每 2 秒重连，不阻塞游戏主线程 */
    private static synchronized void startSenderOnce() {
        if (started) return;
        started = true;
        Thread t = new Thread(() -> {
            OutputStream out = null;
            Socket sock = null;
            while (true) {
                try {
                    if (sock == null || sock.isClosed()) {
                        sock = new Socket();
                        sock.connect(new InetSocketAddress(HOST, PORT), 800);
                        sock.setTcpNoDelay(true);
                        out = sock.getOutputStream();
                    }
                    String line = QUEUE.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS);
                    if (line != null) {
                        out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                        out.flush();
                    }
                } catch (Throwable e) {
                    try { if (sock != null) sock.close(); } catch (Throwable ignored) { }
                    sock = null;
                    out = null;
                    try { Thread.sleep(2000); } catch (InterruptedException ie) { return; }
                }
            }
        }, "dafeiyu-state-sender");
        t.setDaemon(true);
        t.start();
    }
}
