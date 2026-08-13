package app.filterpod.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.shared.model.Category
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Settings
import app.filterpod.shared.model.Severity
import app.filterpod.shared.model.WordOverride
import app.filterpod.ui.Ember
import app.filterpod.ui.components.ChoiceChip
import app.filterpod.ui.components.HairlineDivider
import app.filterpod.ui.components.ScreenHeader
import app.filterpod.ui.components.SectionLabel
import kotlinx.coroutines.launch

/**
 * Settings, ported from src/app/screens/Settings.tsx, plus the playback-default
 * controls the spec adds (default rate, completion threshold, theme).
 *
 * Deliberately worded without examples: an app whose whole job is removing this
 * language should not print it on its own settings screen.
 */
private val PROFILE_BLURBS = mapOf(
    "family" to "The strictest setting. Cuts mild words and casual religious exclamations as well as everything stronger.",
    "standard" to "Cuts strong and moderate language. Milder words and exclamations are left in.",
    "strong-only" to "Cuts only the harshest language. Everything milder plays through.",
    "off" to "No filtering. Episodes play exactly as published.",
)

/** Speeds measured on a Pixel 7 Pro, so the trade-off is concrete rather than vague. */
private val MODEL_BLURBS = mapOf(
    "tiny.en" to "Fastest by a wide margin, and misses more. Worth switching to if filtering struggles to keep up on your phone.",
    "base.en" to "Balanced, and about three times faster than playback — it stays ahead comfortably. The default.",
    "small.en" to "The most accurate, and slow enough that playback may pause to wait for it.",
)

private val PROFILE_ORDER = listOf("family", "standard", "strong-only", "off")

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    settings: Settings,
    onUpdateSettings: ((Settings) -> Settings) -> Unit,
) {
    val app = FilterPodApp.instance
    val repo = app.repo
    val controller = app.controller
    val scope = rememberCoroutineScope()

    val profiles by produceState(initialValue = emptyList<FilterProfile>()) {
        value = repo.listFilterProfiles().sortedBy {
            PROFILE_ORDER.indexOf(it.id).let { i -> if (i < 0) PROFILE_ORDER.size else i }
        }
    }

    // Word overrides have no observe API; a tick re-reads after every mutation.
    var overridesTick by remember { mutableIntStateOf(0) }
    val overrides by produceState(initialValue = emptyList<WordOverride>(), overridesTick) {
        value = repo.listWordOverrides()
    }

    /** Filtering rules changed; re-tune the live session for whatever is playing. */
    fun applyToPlaying() {
        val podcastId = controller.state.value.episode?.podcastId ?: return
        scope.launch { controller.applyProfileChange(podcastId) }
    }

    LazyColumn(Modifier.fillMaxSize()) {
        item(key = "header") { ScreenHeader("Settings") }

        item(key = "filtering") {
            Group("Filtering") {
                Column(
                    Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (profile in profiles) {
                        SelectableCard(
                            title = profile.name,
                            blurb = PROFILE_BLURBS[profile.id],
                            selected = settings.activeFilterProfileId == profile.id,
                            onSelect = {
                                onUpdateSettings { it.copy(activeFilterProfileId = profile.id) }
                                applyToPlaying()
                            },
                        )
                    }
                    Text(
                        "Episodes are filtered as you listen, starting from wherever you press play. " +
                            "Playback never runs past the part that has been checked, so nothing is ever played unfiltered.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        item(key = "words") {
            WordOverridesGroup(
                overrides = overrides,
                onAdd = { term, action, severity ->
                    scope.launch {
                        repo.putWordOverride(
                            WordOverride(
                                term = term,
                                action = action,
                                severity = severity,
                                category = Category.CUSTOM,
                                createdAt = System.currentTimeMillis(),
                            ),
                        )
                        overridesTick++
                        applyToPlaying()
                    }
                },
                onDelete = { term ->
                    scope.launch {
                        repo.deleteWordOverride(term)
                        overridesTick++
                        applyToPlaying()
                    }
                },
            )
        }

        item(key = "transcription") {
            Group("Transcription") {
                Column(
                    Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (model in listOf("tiny.en", "base.en", "small.en")) {
                        SelectableCard(
                            title = model,
                            blurb = MODEL_BLURBS[model],
                            selected = settings.whisperModel == model,
                            onSelect = { onUpdateSettings { it.copy(whisperModel = model) } },
                        )
                    }
                    Text(
                        "Filtering runs on this device. Audio and transcripts never leave it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        item(key = "playback") {
            Group("Playback") {
                ChipRow(
                    title = "Skip forward",
                    options = listOf(15, 30, 45, 60),
                    selected = settings.skipForwardSec,
                    label = { "${it}s" },
                    onSelect = { onUpdateSettings { s -> s.copy(skipForwardSec = it) } },
                )
                HairlineDivider()
                ChipRow(
                    title = "Skip back",
                    options = listOf(5, 10, 15, 30),
                    selected = settings.skipBackSec,
                    label = { "${it}s" },
                    onSelect = { onUpdateSettings { s -> s.copy(skipBackSec = it) } },
                )
                HairlineDivider()
                ChipRow(
                    title = "Playback speed",
                    options = listOf(0.8, 1.0, 1.2, 1.5, 2.0),
                    selected = settings.playbackRate,
                    label = { "${it}×" },
                    onSelect = { rate ->
                        // setRate persists the default and re-tunes anything playing.
                        controller.setRate(rate)
                        onUpdateSettings { s -> s.copy(playbackRate = rate) }
                    },
                )
                HairlineDivider()
                ChipRow(
                    title = "Mark played within",
                    options = listOf(10, 30, 60, 120),
                    selected = settings.completionThresholdSec,
                    label = { "${it}s" },
                    onSelect = { onUpdateSettings { s -> s.copy(completionThresholdSec = it) } },
                )
            }
        }

        item(key = "appearance") {
            Group("Appearance") {
                ChipRow(
                    title = "Theme",
                    options = listOf("dark", "light", "system"),
                    selected = settings.theme,
                    label = { it.replaceFirstChar { c -> c.uppercase() } },
                    onSelect = { onUpdateSettings { s -> s.copy(theme = it) } },
                )
            }
        }
    }
}

@Composable
private fun Group(label: String, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(Modifier.padding(bottom = 20.dp)) {
        SectionLabel(label, Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        HairlineDivider()
        Column(content = content)
        HairlineDivider()
    }
}

@Composable
private fun SelectableCard(
    title: String,
    blurb: String?,
    selected: Boolean,
    onSelect: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(
                if (selected) Ember.copy(alpha = 0.1f)
                else MaterialTheme.colorScheme.surfaceContainer,
            )
            .clickable(onClick = onSelect)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = if (selected) Ember else MaterialTheme.colorScheme.onSurface,
            )
            if (selected) Icon(Icons.Filled.Check, null, Modifier.size(16.dp), tint = Ember)
        }
        if (blurb != null) {
            Text(
                blurb,
                Modifier.padding(top = 4.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun <T> ChipRow(
    title: String,
    options: List<T>,
    selected: T,
    label: (T) -> String,
    onSelect: (T) -> Unit,
) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (option in options) {
                ChoiceChip(
                    label = label(option),
                    selected = option == selected,
                    onSelect = { onSelect(option) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * Custom word overrides: blocked words are cut in addition to the built-in list;
 * allowed words are never cut, even if the built-in list contains them.
 */
@Composable
private fun WordOverridesGroup(
    overrides: List<WordOverride>,
    onAdd: (term: String, action: String, severity: Severity) -> Unit,
    onDelete: (term: String) -> Unit,
) {
    var term by rememberSaveable { mutableStateOf("") }
    var action by rememberSaveable { mutableStateOf(WordOverride.ACTION_BLOCK) }
    var severity by rememberSaveable { mutableStateOf(Severity.MODERATE.name) }

    fun add() {
        val value = term.trim().lowercase()
        if (value.isEmpty()) return
        onAdd(value, action, Severity.valueOf(severity))
        term = ""
    }

    Group("Your words") {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ChoiceChip(
                    "Block",
                    selected = action == WordOverride.ACTION_BLOCK,
                    onSelect = { action = WordOverride.ACTION_BLOCK },
                    modifier = Modifier.weight(1f),
                )
                ChoiceChip(
                    "Allow",
                    selected = action == WordOverride.ACTION_ALLOW,
                    onSelect = { action = WordOverride.ACTION_ALLOW },
                    modifier = Modifier.weight(1f),
                )
            }

            if (action == WordOverride.ACTION_BLOCK) {
                Row(
                    Modifier.padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (option in Severity.entries) {
                        ChoiceChip(
                            option.name.lowercase().replaceFirstChar { it.uppercase() },
                            selected = severity == option.name,
                            onSelect = { severity = option.name },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            Row(
                Modifier.padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = term,
                    onValueChange = { term = it },
                    modifier = Modifier.weight(1f),
                    placeholder = {
                        Text(
                            if (action == WordOverride.ACTION_BLOCK) "Word or phrase to cut"
                            else "Word to leave alone",
                        )
                    },
                    singleLine = true,
                    shape = RoundedCornerShape(50),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Ember.copy(alpha = 0.5f),
                        unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                    ),
                )
                OutlinedButton(onClick = { add() }) {
                    Icon(Icons.Filled.Add, null, Modifier.size(15.dp))
                    Text("Add", Modifier.padding(start = 4.dp))
                }
            }

            if (overrides.isNotEmpty()) {
                // Chip cloud; tapping a chip deletes it, like the web UI.
                androidx.compose.foundation.layout.FlowRow(
                    Modifier.padding(top = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (override in overrides) {
                        val block = override.action == WordOverride.ACTION_BLOCK
                        Row(
                            Modifier
                                .clip(RoundedCornerShape(50))
                                .background(
                                    if (block) Ember.copy(alpha = 0.12f)
                                    else MaterialTheme.colorScheme.secondary.copy(alpha = 0.12f),
                                )
                                .clickable { onDelete(override.term) }
                                .padding(horizontal = 10.dp, vertical = 5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Text(
                                override.term,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (block) Ember else MaterialTheme.colorScheme.secondary,
                            )
                            Icon(
                                Icons.Filled.Close,
                                "Remove ${override.term}",
                                Modifier.size(11.dp),
                                tint = if (block) Ember else MaterialTheme.colorScheme.secondary,
                            )
                        }
                    }
                }
            }

            Text(
                "Blocked words are cut in addition to the built-in list. Allowed words are never cut, even if the built-in list contains them.",
                Modifier.padding(top = 12.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
