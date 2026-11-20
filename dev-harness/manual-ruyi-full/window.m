#import <AppKit/AppKit.h>

@interface Fixture : NSObject <NSApplicationDelegate>
@property NSURL *evidence;
@property NSString *code;
@property NSTextField *targetField;
@property NSTextField *decoyField;
@property NSTextField *receipt;
@property NSMutableArray<NSWindow *> *windows;
@property NSInteger saves;
@end

@implementation Fixture

- (void)record:(NSDictionary *)values {
    NSMutableDictionary *row = [values mutableCopy];
    row[@"time"] = [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]];
    NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:row options:0 error:NULL] mutableCopy];
    [line appendBytes:"\n" length:1];
    if (![NSFileManager.defaultManager fileExistsAtPath:self.evidence.path]) {
        [NSFileManager.defaultManager createFileAtPath:self.evidence.path contents:nil attributes:nil];
    }
    NSError *error = nil;
    NSFileHandle *file = [NSFileHandle fileHandleForWritingToURL:self.evidence error:&error];
    if (!file || ![file seekToEndReturningOffset:NULL error:&error] || ![file writeData:line error:&error]) {
        [NSApp presentError:error];
    }
    [file closeFile];
}

- (NSWindow *)windowWithTitle:(NSString *)title field:(NSTextField *)field
                      readout:(NSTextField *)readout code:(NSString *)code action:(SEL)action {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 510, 240)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
        backing:NSBackingStoreBuffered defer:NO];
    window.title = title;
    window.releasedWhenClosed = NO;
    [self.windows addObject:window];
    NSTextField *codeLabel = [NSTextField labelWithString:[@"验证码 " stringByAppendingString:code]];
    codeLabel.font = [NSFont systemFontOfSize:22 weight:NSFontWeightSemibold];
    field.placeholderString = @"合成验收备注";
    field.accessibilityLabel = @"验收备注";
    NSButton *button = [NSButton buttonWithTitle:@"保存测试" target:self action:action];
    NSStackView *stack = [NSStackView stackViewWithViews:@[codeLabel, field, button, readout]];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.alignment = NSLayoutAttributeLeading;
    stack.spacing = 14;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [window.contentView addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
        [stack.topAnchor constraintEqualToAnchor:window.contentView.topAnchor constant:22],
        [stack.leadingAnchor constraintEqualToAnchor:window.contentView.leadingAnchor constant:22],
        [field.widthAnchor constraintEqualToConstant:380]
    ]];
    return window;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.code = [@"MAC-" stringByAppendingString:[[NSUUID UUID].UUIDString substringToIndex:6]];
    self.windows = [NSMutableArray array];
    self.targetField = [NSTextField textFieldWithString:@""];
    self.decoyField = [NSTextField textFieldWithString:@""];
    self.receipt = [NSTextField labelWithString:@"尚未保存"];
    NSWindow *decoy = [self windowWithTitle:@"Ruyi 手工验收 对照窗口" field:self.decoyField
        readout:[NSTextField labelWithString:@"这是一扇对照窗口"] code:@"DECOY" action:@selector(saveDecoy)];
    [decoy setFrameOrigin:NSMakePoint(140, 200)];
    [decoy orderFront:nil];
    NSWindow *target = [self windowWithTitle:@"Ruyi 手工验收 目标窗口" field:self.targetField
        readout:self.receipt code:self.code action:@selector(saveTarget)];
    [target center];
    [target makeKeyAndOrderFront:nil];
    [self record:@{@"event": @"ready", @"displayedCode": self.code}];
}

- (void)saveTarget {
    self.saves += 1;
    self.receipt.stringValue = [NSString stringWithFormat:@"已保存第 %ld 笔", (long)self.saves];
    [self record:@{@"event": @"target_save", @"text": self.targetField.stringValue, @"count": @(self.saves)}];
}

- (void)saveDecoy {
    [self record:@{@"event": @"decoy_save", @"text": self.decoyField.stringValue}];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) return 64;
        NSApplication *app = [NSApplication sharedApplication];
        Fixture *fixture = [Fixture new];
        fixture.evidence = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
        app.delegate = fixture;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
    }
    return 0;
}
