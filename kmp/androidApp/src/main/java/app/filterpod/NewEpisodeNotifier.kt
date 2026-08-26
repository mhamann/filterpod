package app.filterpod

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Subscription

/**
 * "A new episode is out" notifications, for shows the user asked to be told about.
 *
 * Deliberately quiet by construction: one notification per show rather than per
 * episode (a feed dumping a backlog should not produce eleven buzzes), DEFAULT
 * importance so it does not interrupt, and silence whenever the permission is
 * missing — a podcast player that nags for notification access it was never
 * granted is worse than one that simply does not notify.
 */
class NewEpisodeNotifier(private val context: Context) {

    private val manager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun ensureChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "New episodes",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "When a show you follow publishes"
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    fun canNotify(): Boolean =
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    fun notifyNewEpisodes(subscription: Subscription, episodes: List<Episode>, showTitle: String) {
        if (!canNotify() || episodes.isEmpty()) return
        ensureChannel()

        val newest = episodes.first()
        val text = if (episodes.size == 1) {
            newest.title
        } else {
            "${newest.title} and ${episodes.size - 1} more"
        }

        // Tapping lands on the show, not just the app: the notification is about
        // this show, so that is where "open" should mean.
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_PODCAST_ID, subscription.podcastId)
        }
        val pending = PendingIntent.getActivity(
            context,
            subscription.podcastId.hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = android.app.Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_filterpod)
            .setContentTitle(showTitle)
            .setContentText(text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

        // Keyed by show, so a later refresh replaces rather than stacks.
        manager.notify(subscription.podcastId.hashCode(), notification)
    }

    companion object {
        private const val CHANNEL_ID = "new_episodes"
        const val EXTRA_PODCAST_ID = "app.filterpod.PODCAST_ID"
    }
}
