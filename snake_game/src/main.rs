use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use rand::Rng;
use std::{
    io::{self, Write},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, PartialEq)]
struct Point {
    x: i32,
    y: i32,
}

struct Snake {
    body: Vec<Point>,
    direction: Direction,
    next_direction: Direction,
}

impl Snake {
    fn new() -> Self {
        Snake {
            body: vec![Point { x: 10, y: 10 }],
            direction: Direction::Right,
            next_direction: Direction::Right,
        }
    }

    fn update_direction(&mut self) {
        if (self.direction == Direction::Up && self.next_direction != Direction::Down)
            || (self.direction == Direction::Down && self.next_direction != Direction::Up)
            || (self.direction == Direction::Left && self.next_direction != Direction::Right)
            || (self.direction == Direction::Right && self.next_direction != Direction::Left)
        {
            self.direction = self.next_direction;
        }
    }

    fn move_forward(&mut self) {
        let head = *self.body.first().unwrap();
        let new_head = match self.direction {
            Direction::Up => Point {
                x: head.x,
                y: head.y - 1,
            },
            Direction::Down => Point {
                x: head.x,
                y: head.y + 1,
            },
            Direction::Left => Point {
                x: head.x - 1,
                y: head.y,
            },
            Direction::Right => Point {
                x: head.x + 1,
                y: head.y,
            },
        };
        self.body.insert(0, new_head);
        self.body.pop();
    }

    fn grow(&mut self) {
        let tail = *self.body.last().unwrap();
        self.body.push(tail);
    }

    fn check_collision(&self, width: i32, height: i32) -> bool {
        let head = self.body.first().unwrap();
        if head.x < 0 || head.x >= width || head.y < 0 || head.y >= height {
            return true;
        }
        for segment in self.body.iter().skip(1) {
            if head.x == segment.x && head.y == segment.y {
                return true;
            }
        }
        false
    }
}

fn generate_food(snake: &Snake, width: i32, height: i32) -> Point {
    let mut rng = rand::thread_rng();
    loop {
        let food = Point {
            x: rng.gen_range(0..width),
            y: rng.gen_range(0..height),
        };
        if !snake
            .body
            .iter()
            .any(|&seg| seg.x == food.x && seg.y == food.y)
        {
            return food;
        }
    }
}

fn draw(
    stdout: &mut io::Stdout,
    snake: &Snake,
    food: Point,
    score: u32,
    width: i32,
    height: i32,
) -> io::Result<()> {
    execute!(stdout, EnterAlternateScreen)?;
    print!("\x1B[2J\x1B[H");
    print!("+");
    for _ in 0..width {
        print!("-");
    }
    println!("+");
    for y in 0..height {
        print!("|");
        for x in 0..width {
            let pos = Point { x, y };
            if snake.body.first() == Some(&pos) {
                print!("@");
            } else if snake.body.contains(&pos) {
                print!("o");
            } else if pos == food {
                print!("*");
            } else {
                print!(" ");
            }
        }
        println!("|");
    }
    print!("+");
    for _ in 0..width {
        print!("-");
    }
    println!("+");
    println!(
        "Score: {} | Use arrow keys to move | Press 'q' to quit",
        score
    );
    stdout.flush()?;
    Ok(())
}

fn main() -> io::Result<()> {
    let width = 40;
    let height = 20;
    let mut stdout = io::stdout();
    enable_raw_mode()?;
    execute!(stdout, EnterAlternateScreen)?;
    let mut snake = Snake::new();
    let mut food = generate_food(&snake, width, height);
    let mut score = 0;
    let mut last_update = Instant::now();
    let update_interval = Duration::from_millis(100);
    let mut game_over = false;
    while !game_over {
        if event::poll(Duration::from_millis(10))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Up => snake.next_direction = Direction::Up,
                        KeyCode::Down => snake.next_direction = Direction::Down,
                        KeyCode::Left => snake.next_direction = Direction::Left,
                        KeyCode::Right => snake.next_direction = Direction::Right,
                        KeyCode::Char('q') => break,
                        _ => {}
                    }
                }
            }
        }
        if last_update.elapsed() >= update_interval {
            snake.update_direction();
            let head = *snake.body.first().unwrap();
            let new_head = match snake.direction {
                Direction::Up => Point {
                    x: head.x,
                    y: head.y - 1,
                },
                Direction::Down => Point {
                    x: head.x,
                    y: head.y + 1,
                },
                Direction::Left => Point {
                    x: head.x - 1,
                    y: head.y,
                },
                Direction::Right => Point {
                    x: head.x + 1,
                    y: head.y,
                },
            };
            if new_head == food {
                snake.grow();
                snake.move_forward();
                food = generate_food(&snake, width, height);
                score += 10;
            } else {
                snake.move_forward();
            }
            if snake.check_collision(width, height) {
                game_over = true;
            }
            last_update = Instant::now();
        }
        draw(&mut stdout, &snake, food, score, width, height)?;
    }
    execute!(stdout, LeaveAlternateScreen)?;
    disable_raw_mode()?;
    println!("Game Over! Final Score: {}", score);
    println!("Press Enter to exit...");
    let mut input = String::new();
    io::stdin().read_line(&mut input).ok();
    Ok(())
}
