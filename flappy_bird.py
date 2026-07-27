import random
import pygame

WIDTH, HEIGHT = 480, 640
GROUND_Y = 585
BIRD_X = 125
GRAVITY = 0.55
FLAP = -9.2
PIPE_SPEED = 3.6
PIPE_WIDTH = 72
PIPE_GAP = 155
PIPE_SPACING = 225


SEGMENTS = {
    "0": "abcedf", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
    "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
}


def draw_number(screen, number, x, y, scale=5):
    text = str(number)
    total = len(text) * 8 * scale
    x -= total // 2
    for char in text:
        active = SEGMENTS[char]
        segs = {
            "a": (x + scale, y, 5 * scale, scale),
            "b": (x + 6 * scale, y + scale, scale, 5 * scale),
            "c": (x + 6 * scale, y + 7 * scale, scale, 5 * scale),
            "d": (x + scale, y + 12 * scale, 5 * scale, scale),
            "e": (x, y + 7 * scale, scale, 5 * scale),
            "f": (x, y + scale, scale, 5 * scale),
            "g": (x + scale, y + 6 * scale, 5 * scale, scale),
        }
        for name, rect in segs.items():
            if name in active:
                pygame.draw.rect(screen, (255, 255, 255), rect, border_radius=max(1, scale // 2))
        x += 8 * scale


def make_pipe(x):
    return {"x": float(x), "gap_y": random.randint(165, 420), "scored": False}


def reset_game(best):
    pipes = [make_pipe(WIDTH + 90 + i * PIPE_SPACING) for i in range(3)]
    return {
        "bird_y": HEIGHT / 2,
        "velocity": 0.0,
        "pipes": pipes,
        "score": 0,
        "best": best,
        "running": False,
        "game_over": False,
    }


def draw_scene(screen, state):
    screen.fill((96, 197, 241))
    pygame.draw.ellipse(screen, (223, 246, 255), (35, 70, 150, 65))
    pygame.draw.ellipse(screen, (223, 246, 255), (275, 125, 180, 70))
    pygame.draw.ellipse(screen, (201, 239, 255), (145, 210, 140, 55))

    for x in range(0, WIDTH + 50, 70):
        pygame.draw.polygon(screen, (148, 211, 91), [(x, GROUND_Y), (x + 35, GROUND_Y - 38), (x + 70, GROUND_Y)])

    for pipe in state["pipes"]:
        x = int(pipe["x"])
        gap_top = int(pipe["gap_y"] - PIPE_GAP / 2)
        gap_bottom = int(pipe["gap_y"] + PIPE_GAP / 2)
        green, light, dark = (86, 201, 63), (109, 222, 80), (23, 75, 22)
        pygame.draw.rect(screen, green, (x, 0, PIPE_WIDTH, gap_top))
        pygame.draw.rect(screen, dark, (x, 0, PIPE_WIDTH, gap_top), 3)
        pygame.draw.rect(screen, light, (x - 7, gap_top - 26, PIPE_WIDTH + 14, 26))
        pygame.draw.rect(screen, dark, (x - 7, gap_top - 26, PIPE_WIDTH + 14, 26), 3)
        pygame.draw.rect(screen, green, (x, gap_bottom, PIPE_WIDTH, GROUND_Y - gap_bottom))
        pygame.draw.rect(screen, dark, (x, gap_bottom, PIPE_WIDTH, GROUND_Y - gap_bottom), 3)
        pygame.draw.rect(screen, light, (x - 7, gap_bottom, PIPE_WIDTH + 14, 26))
        pygame.draw.rect(screen, dark, (x - 7, gap_bottom, PIPE_WIDTH + 14, 26), 3)

    pygame.draw.rect(screen, (222, 216, 149), (0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y))
    pygame.draw.rect(screen, (114, 191, 68), (0, GROUND_Y, WIDTH, 12))

    y = int(state["bird_y"])
    pygame.draw.ellipse(screen, (255, 212, 59), (BIRD_X - 18, y - 15, 36, 30))
    pygame.draw.ellipse(screen, (31, 41, 55), (BIRD_X - 18, y - 15, 36, 30), 2)
    pygame.draw.ellipse(screen, (245, 158, 11), (BIRD_X - 8, y - 2, 18, 14))
    pygame.draw.ellipse(screen, (255, 255, 255), (BIRD_X + 7, y - 9, 8, 8))
    pygame.draw.circle(screen, (17, 24, 39), (BIRD_X + 12, y - 5), 2)
    pygame.draw.polygon(screen, (251, 113, 133), [(BIRD_X + 17, y - 2), (BIRD_X + 30, y + 3), (BIRD_X + 17, y + 7)])

    draw_number(screen, state["score"], WIDTH // 2, 35, 4)
    if not state["running"] and not state["game_over"]:
        pygame.draw.circle(screen, (255, 255, 255), (WIDTH // 2, HEIGHT // 2 - 75), 36, 4)
        pygame.draw.polygon(screen, (255, 255, 255), [(WIDTH // 2 - 8, HEIGHT // 2 - 92), (WIDTH // 2 + 18, HEIGHT // 2 - 75), (WIDTH // 2 - 8, HEIGHT // 2 - 58)])
    elif state["game_over"]:
        overlay = pygame.Surface((WIDTH, 150), pygame.SRCALPHA)
        overlay.fill((190, 40, 40, 190))
        screen.blit(overlay, (0, HEIGHT // 2 - 105))
        draw_number(screen, state["score"], WIDTH // 2 - 65, HEIGHT // 2 - 75, 3)
        draw_number(screen, state["best"], WIDTH // 2 + 65, HEIGHT // 2 - 75, 3)
        pygame.draw.circle(screen, (255, 255, 255), (WIDTH // 2, HEIGHT // 2 + 15), 24, 3)
        pygame.draw.polygon(screen, (255, 255, 255), [(WIDTH // 2 - 5, HEIGHT // 2 + 3), (WIDTH // 2 + 12, HEIGHT // 2 + 15), (WIDTH // 2 - 5, HEIGHT // 2 + 27)])


def collided(state):
    left, top, right, bottom = BIRD_X - 17, state["bird_y"] - 14, BIRD_X + 17, state["bird_y"] + 14
    if top <= 0 or bottom >= GROUND_Y:
        return True
    for pipe in state["pipes"]:
        gap_top = pipe["gap_y"] - PIPE_GAP / 2
        gap_bottom = pipe["gap_y"] + PIPE_GAP / 2
        horizontal = right > pipe["x"] - 7 and left < pipe["x"] + PIPE_WIDTH + 7
        if horizontal and (top < gap_top or bottom > gap_bottom):
            return True
    return False


def main():
    pygame.init()
    screen = pygame.display.set_mode((WIDTH, HEIGHT))
    pygame.display.set_caption("Flappy Bird - Python")
    clock = pygame.time.Clock()
    state = reset_game(0)

    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                return
            if event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
                if event.type == pygame.KEYDOWN and event.key not in (pygame.K_SPACE, pygame.K_UP):
                    continue
                if state["game_over"]:
                    state = reset_game(state["best"])
                state["running"] = True
                state["velocity"] = FLAP

        if state["running"] and not state["game_over"]:
            state["velocity"] += GRAVITY
            state["bird_y"] += state["velocity"]
            for pipe in state["pipes"]:
                pipe["x"] -= PIPE_SPEED
                if not pipe["scored"] and pipe["x"] + PIPE_WIDTH < BIRD_X:
                    pipe["scored"] = True
                    state["score"] += 1
            if state["pipes"][0]["x"] + PIPE_WIDTH < -10:
                state["pipes"].pop(0)
                state["pipes"].append(make_pipe(state["pipes"][-1]["x"] + PIPE_SPACING))
            if collided(state):
                state["game_over"] = True
                state["running"] = False
                state["best"] = max(state["best"], state["score"])

        draw_scene(screen, state)
        pygame.display.flip()
        clock.tick(60)


if __name__ == "__main__":
    main()
