# Pack Compatibility Report
*Generated: 2026-05-16T08:34:10.427Z*
MC version: `26.1.2`
Loader: `neoforge`

## Scorecard
✅ No issues detected.

## AT/AW Shared Targets (informational)
> Multiple mods target the same member with different access keywords. AT/AW always resolves to the most permissive level — these are **not** runtime risks.
| Target | Mods (access) |
| --- | --- |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen imageHeight` | `sophisticatedcore` (protected-f), `cyclopscore` (public-f), `ae2` (protected-f), `apothic_enchanting` (protected-f), `polylib` (public-f), `foup` (protected-f), `microredstone` (protected-f) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen imageWidth` | `sophisticatedcore` (protected-f), `cyclopscore` (public-f), `ae2` (protected-f), `apothic_attributes` (public), `polylib` (public-f), `microredstone` (protected-f) |
| `AW:field net/minecraft/world/inventory/Slot x I` | `cyclopscore` (accessible), `cyclopscore` (mutable), `polylib` (accessible), `polylib` (mutable) |
| `AW:field net/minecraft/world/inventory/Slot y I` | `cyclopscore` (accessible), `cyclopscore` (mutable), `polylib` (accessible), `polylib` (mutable) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen draggingItem` | `sophisticatedcore` (protected), `ae2importexportcard` (protected), `polylib` (public) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen isHovering(Lnet/minecraft/world/inventory/Slot;DD)Z` | `sophisticatedcore` (protected), `cyclopscore` (public), `ae2` (protected) |
| `AT:net.minecraft.world.inventory.AbstractContainerMenu containerListeners` | `sophisticatedcore` (protected), `colossalchests` (public), `chiselsandbits` (public) |
| `AW:field net/minecraft/client/gui/screens/inventory/AbstractContainerScreen imageWidth I` | `cyclopscore` (mutable), `polylib` (accessible), `polylib` (mutable) |
| `AW:field net/minecraft/client/gui/screens/inventory/AbstractContainerScreen imageHeight I` | `cyclopscore` (mutable), `polylib` (accessible), `polylib` (mutable) |
| `AT:net.minecraft.world.item.alchemy.PotionBrewing potionMixes` | `commoncapabilities` (public), `jei` (public), `placebo` (public-f) |
| `AT:net.minecraft.world.item.alchemy.PotionBrewing containerMixes` | `commoncapabilities` (public), `jei` (public), `placebo` (public-f) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen isSplittingStack` | `sophisticatedcore` (protected), `polylib` (public) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen quickCraftingRemainder` | `sophisticatedcore` (protected), `polylib` (public) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen clickedSlot` | `sophisticatedcore` (protected), `polylib` (public) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen quickCraftingType` | `sophisticatedcore` (protected), `polylib` (public) |
| `AT:net.minecraft.client.gui.screens.inventory.AbstractContainerScreen recalculateQuickCraftRemaining()V` | `sophisticatedcore` (protected), `polylib` (public) |
| `AT:net.minecraft.world.inventory.AbstractContainerMenu lastSlots` | `sophisticatedcore` (protected), `integrateddynamics` (public) |
| `AT:net.minecraft.world.inventory.AbstractContainerMenu remoteSlots` | `sophisticatedcore` (protected), `integrateddynamics` (public) |
| `AT:net.minecraft.world.inventory.AbstractContainerMenu createCarriedSlotAccess()Lnet/minecraft/world/entity/SlotAccess;` | `sophisticatedcore` (protected), `cyclopscore` (public) |
| `AT:net.minecraft.data.recipes.ShapedRecipeBuilder <init>(Lnet/minecraft/core/HolderGetter;Lnet/minecraft/data/recipes/RecipeCategory;Lnet/minecraft/world/level/ItemLike;I)V` | `enderio` (public), `framedblocks` (protected) |
_…and 4 more. Run `mod_mixins action=at_conflicts` for full list._
