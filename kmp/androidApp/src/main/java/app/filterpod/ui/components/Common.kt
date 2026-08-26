package app.filterpod.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.filterpod.ui.Ember
import coil3.compose.AsyncImage

/** Podcast/episode artwork with a quiet placeholder while it loads. */
@Composable
fun Artwork(
    url: String?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    corner: Int = 10,
) {
    Box(
        modifier
            .clip(RoundedCornerShape(corner.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        if (!url.isNullOrEmpty()) {
            AsyncImage(
                model = url,
                contentDescription = contentDescription,
                contentScale = ContentScale.Crop,
                modifier = Modifier.matchParentSize(),
            )
        }
    }
}

/** The screens' shared header row: big title on a hairline, optional action. */
@Composable
fun ScreenHeader(title: String, action: (@Composable () -> Unit)? = null) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            // Centre, not bottom: the action is an IconButton with a 48dp touch target
            // and its glyph centred inside, so bottom-aligning the two boxes floated
            // the icon well above the title it sits beside.
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            /*
             * Font padding trimmed so the text box hugs its glyphs. Centring two boxes
             * only centres what they contain if the boxes are honest about their
             * contents: headlineSmall reserves ascender/descender room the word does
             * not use, which left the icon sitting visibly high beside it.
             */
            Text(
                title,
                style = MaterialTheme.typography.headlineSmall.copy(
                    platformStyle = PlatformTextStyle(includeFontPadding = false),
                    lineHeightStyle = LineHeightStyle(
                        alignment = LineHeightStyle.Alignment.Center,
                        trim = LineHeightStyle.Trim.Both,
                    ),
                ),
            )
            if (action != null) action()
        }
        HairlineDivider()
    }
}

@Composable
fun HairlineDivider(modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outlineVariant),
    )
}

/** Small uppercase section label, the React app's "silkscreen". */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier,
        style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 1.2.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

enum class PillTone { Neutral, Ember, Sage }

/** Compact status chip. */
@Composable
fun Pill(
    text: String,
    tone: PillTone = PillTone.Neutral,
    icon: ImageVector? = null,
    modifier: Modifier = Modifier,
) {
    val (bg, fg) = when (tone) {
        PillTone.Neutral ->
            MaterialTheme.colorScheme.surfaceContainerHigh to MaterialTheme.colorScheme.onSurfaceVariant
        PillTone.Ember -> Ember.copy(alpha = 0.14f) to Ember
        PillTone.Sage ->
            MaterialTheme.colorScheme.secondary.copy(alpha = 0.15f) to MaterialTheme.colorScheme.secondary
    }
    Row(
        modifier
            .clip(RoundedCornerShape(50))
            .background(bg)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(13.dp), tint = fg)
        Text(text, style = MaterialTheme.typography.labelMedium, color = fg)
    }
}

/** Thin determinate progress bar, tone-able like the React ProgressBar. */
@Composable
fun ThinProgressBar(
    fraction: Float,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    Box(
        modifier
            .fillMaxWidth()
            .height(4.dp)
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest),
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .height(4.dp)
                .background(color),
        )
    }
}

/** Centered empty state with an optional action slot. */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            title,
            Modifier.padding(top = 12.dp),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            body,
            Modifier
                .padding(top = 6.dp)
                .widthIn(max = 280.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (action != null) Box(Modifier.padding(top = 20.dp)) { action() }
    }
}

/** The queue shortcut with a live count badge; same spot on Library and in the player. */
@Composable
fun QueueBadgeButton(count: Int, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        Box {
            Icon(
                Icons.AutoMirrored.Filled.List,
                contentDescription = if (count > 0) "Queue, $count episodes" else "Queue",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (count > 0) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offsetBadge()
                        .clip(CircleShape)
                        .background(Ember)
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                ) {
                    Text(
                        count.toString(),
                        fontSize = 9.sp,
                        lineHeight = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(0xFF15100B),
                    )
                }
            }
        }
    }
}

private fun Modifier.offsetBadge(): Modifier =
    this.then(Modifier.padding(0.dp)) // badge sits inside the icon bounds' corner

/** Row shell for settings-style toggles. */
@Composable
fun ToggleRow(
    title: String,
    detail: String?,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onChange(!checked) }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            if (detail != null) {
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = Ember),
        )
    }
}

/** Selectable chip used for profile/model/increment choices. */
@Composable
fun ChoiceChip(
    label: String,
    selected: Boolean,
    onSelect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .clickable(onClick = onSelect),
        shape = RoundedCornerShape(50),
        color = if (selected) Ember else MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = if (selected) Color(0xFF15100B) else MaterialTheme.colorScheme.onSurfaceVariant,
    ) {
        Text(
            label,
            Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

/** Card-ish grouping container used across Settings and PodcastDetail. */
@Composable
fun PanelCard(modifier: Modifier = Modifier, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(14.dp)),
        content = content,
    )
}
